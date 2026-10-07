import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { SshConnection } from './ssh-connection'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { bundledRipgrepContentKey } from '../ripgrep/bundled-ripgrep-path'
import type { SshTarget } from '../../shared/ssh-types'

// Why opt-in: needs Docker plus an sshd+node+git image WITHOUT rg (ORCA_REVIEW_SSH_NORG_IMAGE).
const RUN = process.env.ORCA_REVIEW_SSH_BUNDLED_RG === '1'
const REMOTE_REPO = '/tmp/orca-bundled-rg-repo'
const TARGET = 'ios/Notion Web Clipper/AppDelegate.swift'
const REPORT = process.env.ORCA_REVIEW_REPORT_FILE

type Fixture = { containerName: string; identityFile: string; port: number; tempDir: string }

function run(command: string, args: string[], timeout = 60_000): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout
  })
    .toString()
    .trim()
}

function dockerExec(fixture: Fixture, command: string): string {
  return run('docker', ['exec', fixture.containerName, 'bash', '-lc', command], 120_000)
}

function report(line: string): void {
  if (REPORT) {
    appendFileSync(REPORT, `${line}\n`)
  }
}

function startTarget(): Fixture {
  const image = process.env.ORCA_REVIEW_SSH_NORG_IMAGE ?? 'orca-ssh-norg:latest'
  const tempDir = mkdtempSync(join(tmpdir(), 'orca-bundled-rg-ssh-'))
  const identityFile = join(tempDir, 'id_ed25519')
  run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', identityFile, '-q'])
  const publicKey = readFileSync(`${identityFile}.pub`, 'utf8').trim()
  const containerName = `orca-bundled-rg-${randomUUID().slice(0, 12)}`
  run('docker', [
    'run',
    '-d',
    '--name',
    containerName,
    '-p',
    '127.0.0.1::22',
    '-e',
    `AUTHORIZED_KEY=${publicKey}`,
    image,
    'bash',
    '-lc',
    'printf "%s\\n" "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e'
  ])
  const port = Number(run('docker', ['port', containerName, '22/tcp']).split(':').at(-1))
  const fixture = { containerName, identityFile, port, tempDir }
  // Why 25k files: past the 20,001-path listing cap, so only a real rg search finds the target.
  dockerExec(
    fixture,
    [
      `mkdir -p '${REMOTE_REPO}' && cd '${REMOTE_REPO}' && git init -q`,
      `for d in $(seq 0 249); do mkdir -p a$d && (cd a$d && for i in $(seq 0 99); do : > f$i.txt; done); done`,
      `mkdir -p 'ios/Notion Web Clipper' && echo 'class AppDelegate {}' > '${TARGET}'`,
      'git add -A >/dev/null'
    ].join(' && ')
  )
  return fixture
}

function stopTarget(fixture: Fixture | null): void {
  if (!fixture) {
    return
  }
  spawnSync('docker', ['rm', '-f', fixture.containerName], { stdio: 'ignore', timeout: 30_000 })
  rmSync(fixture.tempDir, { recursive: true, force: true })
}

function createConnection(fixture: Fixture): SshConnection {
  const target: SshTarget = {
    id: `bundled-rg-${randomUUID()}`,
    label: 'Bundled ripgrep Docker SSH target',
    source: 'manual',
    host: '127.0.0.1',
    port: fixture.port,
    username: 'root',
    identityFile: fixture.identityFile,
    identitiesOnly: true
  }
  return new SshConnection(target, { onStateChange: vi.fn() })
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<number> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) {
      return Date.now() - startedAt
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

describe.skipIf(!RUN)('SSH relay bundled ripgrep', () => {
  let fixture: Fixture | null = null

  beforeAll(() => {
    fixture = startTarget()
  }, 300_000)

  afterAll(() => {
    stopTarget(fixture)
  })

  it('installs Orca ripgrep on a host without rg and serves Quick Open search with it', async () => {
    const active = fixture!
    expect(dockerExec(active, 'command -v rg || echo NO_RG')).toBe('NO_RG')
    const platform = /^(aarch64|arm64)$/.test(dockerExec(active, 'uname -m'))
      ? 'linux-arm64'
      : 'linux-x64'
    const entry = `${bundledRipgrepContentKey(platform)}-${platform}`
    const remoteBinary = `/root/.orca-remote/ripgrep/${entry}/rg`
    const connection = createConnection(active)
    await connection.connect()
    try {
      const deployStartedAt = Date.now()
      const deployed = await deployAndLaunchRelay(connection, undefined, 60)
      const deployMs = Date.now() - deployStartedAt
      const installMs = await waitFor(
        () => dockerExec(active, `test -x '${remoteBinary}' && echo yes || echo no`) === 'yes',
        60_000
      )
      report(
        `SSH deploy_ms=${deployMs} rg_installed_after_launch_ms=${installMs} platform=${platform}`
      )
      expect(dockerExec(active, `'${remoteBinary}' --version | head -1`)).toContain('ripgrep')
      expect(dockerExec(active, "ps -eo args | grep '[r]elay.js --detached'")).toContain(
        `--ripgrep-path ${remoteBinary}`
      )
      expect(dockerExec(active, `ls /root/.orca-remote/ripgrep/${entry}`)).toBe('rg')

      const mux = new SshChannelMultiplexer(deployed.transport)
      try {
        await mux.request('session.registerRoot', { rootPath: REMOTE_REPO })
        const searchStartedAt = Date.now()
        const files = await mux.request('fs.listFiles', {
          rootPath: REMOTE_REPO,
          searchQuery: 'AppDelegate',
          maxResults: 33
        })
        report(
          `SSH quick_open_search_ms=${Date.now() - searchStartedAt} result=${JSON.stringify(files)}`
        )
        expect(files).toEqual([TARGET])

        const textStartedAt = Date.now()
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: relay fs.search resolves a SearchResult.
        const text = (await mux.request('fs.search', {
          query: 'class AppDelegate',
          rootPath: REMOTE_REPO
        })) as { files: { relativePath: string }[] }
        report(`SSH text_search_ms=${Date.now() - textStartedAt} files=${text.files.length}`)
        expect(text.files.map((file) => file.relativePath)).toEqual([TARGET])
      } finally {
        mux.dispose()
      }
    } finally {
      await connection.disconnect()
    }
  }, 300_000)

  it('reuses the installed binary on the next deploy without re-uploading', async () => {
    const active = fixture!
    const before = dockerExec(active, 'stat -c %Y /root/.orca-remote/ripgrep/*/rg')
    const connection = createConnection(active)
    await connection.connect()
    try {
      await deployAndLaunchRelay(connection, undefined, 60)
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      expect(dockerExec(active, 'stat -c %Y /root/.orca-remote/ripgrep/*/rg')).toBe(before)
      expect(dockerExec(active, 'ls -A /root/.orca-remote/ripgrep | grep -c upload || true')).toBe(
        '0'
      )
    } finally {
      await connection.disconnect()
    }
  }, 300_000)
})
