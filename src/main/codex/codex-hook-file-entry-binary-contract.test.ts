import { execFile, execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexListedHook } from './codex-app-server-client'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  getCodexManagedHookInstallMaterial
} from './codex-hook-definition'
import type * as CodexCommand from '../codex-cli/command'
import {
  buildScratchHooksJson,
  deriveCodexHookHashes,
  fingerprintCodex,
  listCodexHooks,
  probeCodexVersion,
  type CodexHookAnswer,
  type CodexHookHashes
} from './codex-hook-trust-derivation'
import { _internals as lookupInternals, startCodexHookHashLookup } from './codex-hook-hash-lookup'
import { memoizeCodexHookAnswer } from './codex-hook-trust-memo'
import { reconcileRealHomeCodexHookEntries } from './codex-real-home-hook-install'
import {
  getCodexExplicitHomeHookSourcePath,
  computeTrustKey,
  normalizeHookTrustKeyForLookup,
  upsertHookTrustEntries,
  upsertProjectTrustLevelInContent
} from './config-toml-trust'

vi.mock('../codex-cli/command', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexCommand>()),
  resolveCodexCommand: () => process.env.ORCA_CODEX_HOOK_CONTRACT_BINARY ?? 'codex'
}))
vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('the contract names every path through env')
    }
  }
}))

import { CodexHookService } from './hook-service'

// Why this file exists: Orca approves its status hook in managed Codex homes
// and in ~/.codex with the hash Codex reports for it in a throwaway home. Only a
// real binary can say whether that hash is the same wherever the entry sits,
// whether Codex then lists Orca's entry as trusted, and whether it runs in a real
// turn with no review. If any of those drift, users meet a review screen or lose
// status while every unit test stays green.

const execFileAsync = promisify(execFile)
const binary = process.env.ORCA_CODEX_HOOK_CONTRACT_BINARY
const expectedVersion = process.env.ORCA_CODEX_HOOK_CONTRACT_VERSION
const TIMEOUT_MS = 60_000

describe.runIf(process.env.ORCA_CODEX_HOOK_CONTRACT_REQUIRED === '1' && !binary)(
  'codex hook file-entry contract prerequisites',
  () => {
    it('was given a Codex binary to run against', () => {
      expect.fail('ORCA_CODEX_HOOK_CONTRACT_REQUIRED=1 but no binary was given')
    })
  }
)

describe.runIf(binary)('codex hook file-entry binary contract', { timeout: 180_000 }, () => {
  let root: string
  let home: string
  let answer: Extract<CodexHookAnswer, { kind: 'hashes' }>
  let hashes: CodexHookHashes

  beforeAll(async () => {
    // Why a disposable HOME: nothing here may read or write the user's own ~/.codex.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-codex-hook-contract-')))
    const version = await execFileAsync(binary!, ['--version'], {
      timeout: TIMEOUT_MS,
      env: { ...process.env, HOME: join(root, 'version-home'), CODEX_HOME: join(root, 'v') }
    })
    if (expectedVersion) {
      expect(version.stdout.trim()).toBe(`codex-cli ${expectedVersion}`)
    }
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  beforeEach(async () => {
    home = mkdtempSync(join(root, 'home-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CODEX_HOME', join(root, 'never-used-codex-home'))
    vi.stubEnv('ORCA_USER_DATA_PATH', join(home, 'user-data'))
    // Why: the app's userData always exists; the memo is written there.
    mkdirSync(join(home, 'user-data'))
    const codexVersion = await probeCodexVersion(binary!)
    expect(codexVersion).not.toBeNull()
    const derived = await deriveCodexHookHashes(binary!, command(), codexVersion!)
    if (derived.kind !== 'hashes') {
      throw new Error(`Codex gave no hashes: ${derived.failure}`)
    }
    answer = derived
    hashes = derived.hashes
  })

  afterEach(() => {
    lookupInternals.resetForTesting()
    vi.unstubAllEnvs()
  })

  const command = (): string => getCodexManagedHookInstallMaterial().command
  const accountHome = (): string => join(home, 'user-data', 'codex-accounts', 'one', 'home')

  /** Orca's entry installed into a managed account home, approved with the derived hashes. */
  async function installManagedHome(): Promise<void> {
    mkdirSync(join(home, '.codex'), { recursive: true })
    // Why saved: the app's lookup then re-probes the version and finds the answer, with no second hooks/list.
    memoizeCodexHookAnswer(binary!, fingerprintCodex(binary!)!, command(), answer)
    startCodexHookHashLookup(Promise.resolve())
    expect((await new CodexHookService().install(accountHome())).state).toBe('installed')
  }

  async function orcaListings(codexHome: string): Promise<CodexListedHook[]> {
    // Why a cwd outside any project: only the home's own hooks.json is listed.
    const cwd = mkdtempSync(join(root, 'cwd-'))
    return (await listCodexHooks(binary!, codexHome, cwd)).filter(
      (listing) => listing.command === command()
    )
  }

  it("hashes Orca's entry alike at group 0, after another group, and from a trusted project", async () => {
    const scratch = mkdtempSync(join(root, 'scratch-'))
    const project = mkdtempSync(join(root, 'project-'))
    mkdirSync(join(project, '.codex'))
    writeFileSync(join(scratch, 'hooks.json'), buildScratchHooksJson(command(), true))
    writeFileSync(join(project, '.codex', 'hooks.json'), buildScratchHooksJson(command(), false))
    writeFileSync(
      join(scratch, 'config.toml'),
      upsertProjectTrustLevelInContent('', project, 'trusted')
    )

    const listings = await listCodexHooks(binary!, scratch, project)

    // Why each copy must be listed: a copy Codex stops listing would make the cross-check vacuous.
    for (const [label, hash] of Object.entries(hashes)) {
      const copies = [
        `${join(scratch, 'hooks.json')}:${label}:0:0`,
        `${join(scratch, 'hooks.json')}:${label}:2:0`,
        `${join(project, '.codex', 'hooks.json')}:${label}:0:0`
      ].map((key) =>
        listings.find(
          (listing) =>
            listing.command === command() &&
            normalizeHookTrustKeyForLookup(listing.key) === normalizeHookTrustKeyForLookup(key)
        )
      )
      expect(copies.map((copy) => copy?.currentHash)).toEqual([hash, hash, hash])
    }
    // Why: every pinned Codex knows every event Orca installs into, and hashes each.
    expect(Object.keys(hashes).sort()).toEqual(
      CODEX_EVENTS.map((eventName) => CODEX_EVENT_LABEL[eventName]).sort()
    )
    expect(Object.values(hashes).every((hash) => typeof hash === 'string')).toBe(true)
  })

  it('lists every entry Orca wrote in a managed home as trusted and enabled, and writes nothing on a list', async () => {
    await installManagedHome()
    const files = ['hooks.json', 'config.toml'].map((name) => join(accountHome(), name))
    const before = files.map((file) => readFileSync(file, 'utf-8'))

    const listings = await orcaListings(accountHome())

    expect(listings.map((listing) => listing.key.split(':').at(-3)).sort()).toEqual(
      Object.keys(hashes).sort()
    )
    expect(listings.every((listing) => listing.trustStatus === 'trusted')).toBe(true)
    expect(listings.every((listing) => listing.enabled !== false)).toBe(true)
    expect(files.map((file) => readFileSync(file, 'utf-8'))).toEqual(before)
    // Why: the key Orca approves is the one Codex lists for its managed-home entry.
    const stop = listings.find((listing) => listing.key.includes(':stop:'))
    expect(normalizeHookTrustKeyForLookup(stop!.key)).toBe(
      normalizeHookTrustKeyForLookup(
        computeTrustKey({
          sourcePath: getCodexExplicitHomeHookSourcePath(join(accountHome(), 'hooks.json')),
          eventLabel: CODEX_EVENT_LABEL.Stop,
          groupIndex: 0,
          handlerIndex: 0,
          command: command()
        })
      )
    )
  })

  it.skipIf(process.platform === 'win32')(
    'runs the managed-home entry in a real turn with no review, posting to the pane that started Codex',
    async () => {
      await installManagedHome()
      const posts: string[] = []
      const receiver = await listen(recordPosts(posts))
      const model = await startMockResponses()
      let stderr = ''
      try {
        const workdir = join(home, 'work')
        mkdirSync(workdir)
        const run = execFileAsync(
          binary!,
          [
            '-c',
            'model_provider=mock',
            '-c',
            `model_providers.mock={name="mock",base_url="http://127.0.0.1:${port(model)}/v1",wire_api="responses",env_key="ORCA_CONTRACT_MOCK_KEY"}`,
            'exec',
            '--skip-git-repo-check',
            'say hi'
          ],
          {
            cwd: workdir,
            timeout: TIMEOUT_MS,
            env: {
              PATH: process.env.PATH,
              HOME: home,
              CODEX_HOME: accountHome(),
              ORCA_CONTRACT_MOCK_KEY: 'x',
              ORCA_PANE_KEY: 'contract-pane',
              ORCA_AGENT_HOOK_PORT: String(port(receiver)),
              ORCA_AGENT_HOOK_TOKEN: 'contract-token'
            }
          }
        )
        // Why: `codex exec` also reads a prompt from stdin until it closes.
        run.child.stdin?.end()
        stderr = (await run).stderr
      } finally {
        model.close()
        receiver.close()
      }
      expect(posts.length).toBeGreaterThan(0)
      expect(posts.every((url) => url.includes('codex'))).toBe(true)
      expect(stderr).not.toMatch(/need(s)? review/i)
    }
  )

  it.skipIf(process.platform === 'win32' || !hasPython())(
    'shows no review in a real TUI start on the managed home, and the hook posts',
    async () => {
      await installManagedHome()
      const { screen, posts } = await runCodexTui()
      expect(screen).not.toMatch(/eeds?review/i)
      expect(posts.length).toBeGreaterThan(0)
    }
  )

  it.skipIf(process.platform === 'win32' || !hasPython())(
    'shows the review in a real TUI start when the approval does not match (control)',
    async () => {
      await installManagedHome()
      upsertHookTrustEntries(join(accountHome(), 'config.toml'), [
        {
          sourcePath: getCodexExplicitHomeHookSourcePath(join(accountHome(), 'hooks.json')),
          eventLabel: 'stop',
          groupIndex: 0,
          handlerIndex: 0,
          command: command(),
          trustedHash: `sha256:${'0'.repeat(64)}`,
          enabled: true
        }
      ])
      const { screen } = await runCodexTui()
      expect(screen).toMatch(/eeds?review/i)
    }
  )

  describe('~/.codex', () => {
    /** A disposable HOME whose ~/.codex holds Orca's reconciled entry; a symlink, so both key spellings count. */
    async function freshRealHomeWithEntry(name: string): Promise<void> {
      home = join(root, `${name}-home`)
      symlinkSync(mkdtempSync(join(root, `${name}-`)), home, 'junction')
      vi.stubEnv('HOME', home)
      vi.stubEnv('USERPROFILE', home)
      vi.stubEnv('CODEX_HOME', '')
      vi.stubEnv('ORCA_USER_DATA_PATH', join(home, 'user-data'))
      mkdirSync(join(home, 'user-data'))
      await reconcileRealHome()
    }

    async function reconcileRealHome(): Promise<void> {
      await reconcileRealHomeCodexHookEntries({
        hashes,
        isEnabled: () => true,
        convertOlderForms: false
      })
    }

    const realCodexHome = (): string => join(home, '.codex')

    async function realHomeListings(): Promise<CodexListedHook[]> {
      // Why a cwd outside any project: only the home's own hooks.json is listed.
      const cwd = mkdtempSync(join(root, 'cwd-'))
      return (await listCodexHooks(binary!, null, cwd)).filter(
        (listing) => listing.command === command()
      )
    }

    function stopAt(groupIndex: number): Parameters<typeof computeTrustKey>[0] {
      return {
        sourcePath: join(realCodexHome(), 'hooks.json'),
        eventLabel: 'stop',
        groupIndex,
        handlerIndex: 0,
        command: command()
      }
    }

    async function listedStop(groupIndex: number): Promise<CodexListedHook | undefined> {
      const key = normalizeHookTrustKeyForLookup(computeTrustKey(stopAt(groupIndex)))
      return (await realHomeListings()).find(
        (listing) => normalizeHookTrustKeyForLookup(listing.key) === key
      )
    }

    it('lists every entry Orca wrote as trusted and enabled, and a second check writes nothing', async () => {
      await freshRealHomeWithEntry('trusted')
      const files = ['hooks.json', 'config.toml'].map((name) => join(realCodexHome(), name))
      const before = files.map((file) => readFileSync(file, 'utf-8'))

      const listings = await realHomeListings()

      expect(listings.map((listing) => listing.key.split(':').at(-3)).sort()).toEqual(
        Object.keys(hashes).sort()
      )
      expect(listings.every((listing) => listing.trustStatus === 'trusted')).toBe(true)
      expect(listings.every((listing) => listing.enabled !== false)).toBe(true)
      await reconcileRealHome()
      expect(files.map((file) => readFileSync(file, 'utf-8'))).toEqual(before)
    })

    it("turns the entry back on over the user's /hooks switch-off", async () => {
      await freshRealHomeWithEntry('switched-off')
      upsertHookTrustEntries(join(realCodexHome(), 'config.toml'), [
        { ...stopAt(0), trustedHash: hashes.stop!, enabled: false }
      ])
      expect((await listedStop(0))?.enabled).toBe(false)

      await reconcileRealHome()

      expect(await listedStop(0)).toMatchObject({ trustStatus: 'trusted', enabled: true })
    })

    it('lists the entry for review after a user inserts a hook ahead, until the next check', async () => {
      await freshRealHomeWithEntry('inserted')
      const hooksPath = join(realCodexHome(), 'hooks.json')
      const file = JSON.parse(readFileSync(hooksPath, 'utf-8'))
      file.hooks.Stop.unshift({ hooks: [{ type: 'command', command: 'true' }] })
      writeFileSync(hooksPath, `${JSON.stringify(file, null, 2)}\n`)
      expect((await listedStop(1))?.trustStatus).not.toBe('trusted')

      await reconcileRealHome()

      expect((await listedStop(1))?.trustStatus).toBe('trusted')
      expect((await realHomeListings()).every((listing) => listing.trustStatus === 'trusted')).toBe(
        true
      )
    })

    it('leaves a config.toml with inline hook approvals loadable, writing nothing to it', async () => {
      await freshRealHomeWithEntry('inline')
      const tomlPath = join(realCodexHome(), 'config.toml')
      const inline = `model = "m"\n[hooks]\nstate = { ${JSON.stringify(`${join(realCodexHome(), 'hooks.json')}:stop:0:0`)} = { trusted_hash = "sha256:user" } }\n`
      writeFileSync(tomlPath, inline)
      const file = JSON.parse(readFileSync(join(realCodexHome(), 'hooks.json'), 'utf-8'))
      file.hooks.Stop.unshift({ hooks: [{ type: 'command', command: 'true' }] })
      writeFileSync(join(realCodexHome(), 'hooks.json'), `${JSON.stringify(file, null, 2)}\n`)

      await reconcileRealHome()

      expect(readFileSync(tomlPath, 'utf-8')).toBe(inline)
      // Why: Codex refuses to start at all with a config.toml it cannot load.
      await expect(realHomeListings()).resolves.toBeDefined()
    })

    it.skipIf(process.platform === 'win32' || !hasPython())(
      'shows no review in a real TUI start on ~/.codex, and the hook posts',
      async () => {
        await freshRealHomeWithEntry('tui')
        const { screen, posts } = await runCodexTui(null)
        expect(screen).not.toMatch(/eeds?review/i)
        expect(posts.length).toBeGreaterThan(0)
      }
    )
  })

  /** A TUI Codex in a pty: start, type a prompt, quit; the screen without spaces or escapes. */
  async function runCodexTui(
    codexHome: string | null = accountHome()
  ): Promise<{ screen: string; posts: string[] }> {
    const codexHomeEnv = codexHome ? { CODEX_HOME: codexHome } : {}
    const posts: string[] = []
    const receiver = await listen(recordPosts(posts))
    const model = await startMockResponses()
    // Why resolved: Codex 0.158 matches the trusted project only by the real path, and a symlinked
    // HOME (the ~/.codex case) left it untrusted, so the turn never ran and no hook posted.
    const workdir = join(realpathSync(home), 'tui-work')
    mkdirSync(workdir, { recursive: true })
    const out = join(home, 'tui.out')
    const help = await execFileAsync(binary!, ['--help'], {
      env: { PATH: process.env.PATH, HOME: home, ...codexHomeEnv }
    })
    try {
      await execFileAsync(
        'python3',
        [
          '-c',
          PTY_DRIVER,
          out,
          'say hi',
          workdir,
          '--',
          binary!,
          ...(help.stdout.includes('--no-daemon') ? ['--no-daemon'] : []),
          '-c',
          'model_provider=mock',
          '-c',
          `model_providers.mock={name="mock",base_url="http://127.0.0.1:${port(model)}/v1",wire_api="responses",env_key="ORCA_CONTRACT_MOCK_KEY"}`,
          '-c',
          'check_for_update_on_startup=false',
          '-c',
          `projects={${JSON.stringify(workdir)}={trust_level="trusted"}}`
        ],
        {
          timeout: TIMEOUT_MS,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            ...codexHomeEnv,
            TERM: 'xterm-256color',
            ORCA_CONTRACT_MOCK_KEY: 'x',
            ORCA_PANE_KEY: 'contract-pane',
            ORCA_AGENT_HOOK_PORT: String(port(receiver)),
            ORCA_AGENT_HOOK_TOKEN: 'contract-token'
          }
        }
      )
    } finally {
      model.close()
      receiver.close()
    }
    const screen = readFileSync(out, 'utf-8').replace(/\s+/g, '')
    return { screen, posts }
  }
})

// Why a pty: Codex's review screen only exists in the TUI, which `codex exec` never shows.
const PTY_DRIVER = `
import os, pty, re, sys, time, select, signal, struct, fcntl, termios
out, prompt, cwd = sys.argv[1], sys.argv[2], sys.argv[3]
cmd = sys.argv[sys.argv.index('--') + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd); os.execv(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
buf = b''
def pump(sec):
    global buf
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                return
            if not d: return
            buf += d
            if b'\\x1b[6n' in d: os.write(fd, b'\\x1b[1;1R')
pump(8)
os.write(fd, prompt.encode()); time.sleep(0.5); os.write(fd, b'\\r'); pump(10)
for _ in range(3):
    try: os.write(fd, b'\\x03')
    except OSError: break
    pump(1)
try: os.kill(pid, signal.SIGKILL)
except ProcessLookupError: pass
buf = re.sub(rb'\\x1b\\[[0-9;?<>=]*[A-Za-z]', b'', buf)
buf = re.sub(rb'\\x1b\\][^\\x07]*\\x07', b'', buf)
open(out, 'wb').write(buf)
`

function hasPython(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function recordPosts(posts: string[]): Server {
  return createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      posts.push(request.url ?? '')
      response.writeHead(204).end()
    })
  })
}

function listen(server: Server): Promise<Server> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function port(server: Server): number {
  const address = server.address()
  return address && typeof address === 'object' ? address.port : 0
}

/** A minimal Responses stream: one assistant message, then completion. */
function startMockResponses(): Promise<Server> {
  const event = (payload: Record<string, unknown>): string =>
    `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`
  return listen(
    createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
          response.writeHead(404).end()
          return
        }
        const id = 'resp_contract'
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          event({ type: 'response.created', response: { id } }) +
            event({
              type: 'response.output_item.done',
              item: {
                type: 'message',
                role: 'assistant',
                id: 'msg_contract',
                content: [{ type: 'output_text', text: 'hi' }]
              }
            }) +
            event({
              type: 'response.completed',
              response: {
                id,
                usage: {
                  input_tokens: 0,
                  input_tokens_details: null,
                  output_tokens: 0,
                  output_tokens_details: null,
                  total_tokens: 0
                }
              }
            })
        )
      })
    })
  )
}
