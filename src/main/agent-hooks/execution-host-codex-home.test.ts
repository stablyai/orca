import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  resolveExecutionHostCodexHome,
  resolveRedirectedExecutionHostCodexHome
} from './execution-host-agent-homes'
import { installManagedHooks } from './managed-hook-runtime'

const tempHomes: string[] = []
const tempRoot = process.platform === 'win32' ? tmpdir() : '/tmp'

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(join(tempRoot, 'orca-execution-host-codex-'))
  tempHomes.push(home)
  return home
}

/**
 * A login shell whose `codex` resolves to a stub app-server, standing in for the
 * host wrapper in the report: CODEX_HOME exists only for the Codex process, so
 * the handshake is the only place the real home is observable.
 */
async function stubLoginShellWithCodex(
  home: string,
  { reportedHome }: { reportedHome: string | null }
): Promise<void> {
  const server = [
    "const readline = require('node:readline')",
    "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
    '  const message = JSON.parse(line)',
    "  if (typeof message.id !== 'number') return",
    `  const result = ${reportedHome === null ? '{}' : `{ codexHome: ${JSON.stringify(reportedHome)} }`}`,
    "  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n')",
    '})',
    ''
  ].join('\n')
  const serverPath = join(home, 'codex-app-server.js')
  await writeFile(serverPath, server, 'utf8')
  const shell = join(home, 'login-shell')
  await writeFile(
    shell,
    [
      '#!/bin/sh',
      'case "$2" in',
      `  *"codex app-server"*) exec ${JSON.stringify(process.execPath)} ${JSON.stringify(serverPath)} ;;`,
      '  *) exit 0 ;;',
      'esac',
      ''
    ].join('\n'),
    'utf8'
  )
  await chmod(shell, 0o755)
  vi.stubEnv('HOME', home)
  vi.stubEnv('SHELL', shell)
}

/** A login shell with no `codex` at all: the probe must degrade, not throw. */
async function stubLoginShellWithoutCodex(home: string): Promise<void> {
  const shell = join(home, 'login-shell')
  await writeFile(shell, '#!/bin/sh\nexit 127\n', 'utf8')
  await chmod(shell, 0o755)
  vi.stubEnv('HOME', home)
  vi.stubEnv('SHELL', shell)
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe.runIf(process.platform !== 'win32')('resolveExecutionHostCodexHome', () => {
  it('reports the home the host Codex resolved, not the default', async () => {
    const home = await createTempHome()
    await stubLoginShellWithCodex(home, { reportedHome: `${home}/.codex-openai` })

    await expect(resolveExecutionHostCodexHome(home)).resolves.toBe(`${home}/.codex-openai`)
  })

  it('normalizes a trailing separator on the reported home', async () => {
    const home = await createTempHome()
    await stubLoginShellWithCodex(home, { reportedHome: `${home}/.codex-openai///` })

    await expect(resolveExecutionHostCodexHome(home)).resolves.toBe(`${home}/.codex-openai`)
  })

  it('falls back when the reported home is not an absolute POSIX path', async () => {
    const home = await createTempHome()
    await stubLoginShellWithCodex(home, { reportedHome: '../relative' })

    await expect(resolveExecutionHostCodexHome(home)).resolves.toBe(`${home}/.codex`)
  })

  it('falls back when the handshake reports no home at all', async () => {
    const home = await createTempHome()
    await stubLoginShellWithCodex(home, { reportedHome: null })

    await expect(resolveExecutionHostCodexHome(home)).resolves.toBe(`${home}/.codex`)
  })

  it('falls back when the host has no usable codex', async () => {
    const home = await createTempHome()
    await stubLoginShellWithoutCodex(home)

    await expect(resolveExecutionHostCodexHome(home)).resolves.toBe(`${home}/.codex`)
  })
})

describe.runIf(process.platform !== 'win32')('resolveRedirectedExecutionHostCodexHome', () => {
  it('returns nothing when the host uses the default home', async () => {
    const home = await createTempHome()
    await stubLoginShellWithCodex(home, { reportedHome: `${home}/.codex` })

    await expect(resolveRedirectedExecutionHostCodexHome(home)).resolves.toBeUndefined()
  })

  it('returns the home only when it is genuinely redirected', async () => {
    const home = await createTempHome()
    await stubLoginShellWithCodex(home, { reportedHome: `${home}/.codex-openai` })

    await expect(resolveRedirectedExecutionHostCodexHome(home)).resolves.toBe(
      `${home}/.codex-openai`
    )
  })
})

describe.runIf(process.platform !== 'win32')('installManagedHooks on a redirecting host', () => {
  it('installs Codex hooks into the home Codex actually reads', async () => {
    const home = await createTempHome()
    const redirected = join(home, '.codex-openai')
    await mkdir(redirected, { recursive: true })
    await stubLoginShellWithCodex(home, { reportedHome: redirected })

    await expect(installManagedHooks({ agents: ['codex'] })).resolves.toEqual({
      installers: 1,
      errors: 0
    })

    const installed = JSON.parse(await readFile(join(redirected, 'hooks.json'), 'utf8')) as {
      hooks: Record<string, unknown>
    }
    expect(Object.keys(installed.hooks).length).toBeGreaterThan(0)
    expect(JSON.stringify(installed)).toContain('codex-hook.sh')
    // Why: the whole defect is hooks landing in a home Codex never reads.
    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(false)
    // Why: only the config location moves. A redirected home on an SSH host is
    // the user's own, with no Orca runtime installer writing it, so it keeps the
    // guest-home script contract rather than the runtime-installer one.
    expect(existsSync(join(home, '.orca', 'agent-hooks', 'codex-hook.sh'))).toBe(true)
    expect(existsSync(join(redirected, '.orca', 'agent-hooks', 'codex-hook.sh'))).toBe(false)
  })

  it('leaves a host that does not redirect on its existing install contract', async () => {
    const home = await createTempHome()
    await stubLoginShellWithCodex(home, { reportedHome: `${home}/.codex` })

    await expect(installManagedHooks({ agents: ['codex'] })).resolves.toEqual({
      installers: 1,
      errors: 0
    })

    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(true)
    // Why: the guest-home script location is the unchanged plain-SSH contract.
    // Passing the default home through as a redirect would move it and silently
    // reorder every user's hooks, so pin where it lands.
    expect(existsSync(join(home, '.orca', 'agent-hooks', 'codex-hook.sh'))).toBe(true)
    expect(await readdir(join(home, '.codex'))).not.toContain('.orca')
  })
})
