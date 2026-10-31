import { execFile, execFileSync } from 'node:child_process'
import {
  existsSync,
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
import { StringDecoder } from 'node:string_decoder'
import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import { createCodexComposerReadyScanner } from '../../shared/codex-composer-ready-scanner'
import { createTerminalEscapeScanner } from '../../shared/terminal-escape-scanner'
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
  resolveCodexCommand: () => process.env.ORCA_CODEX_HOOK_CONTRACT_BINARY ?? 'codex',
  resolveCodexCommandForSpawn: async () => process.env.ORCA_CODEX_HOOK_CONTRACT_BINARY ?? 'codex'
}))
vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('the contract names every path through env')
    }
  }
}))

import { CodexHookService } from './hook-service'

// Real binaries must confirm portable hashes, trusted listings and hook delivery without review.

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
    // Isolate all probes from the user's ~/.codex.
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
    // Match the app's existing userData directory for memo writes.
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

  async function installManagedHome(): Promise<void> {
    mkdirSync(join(home, '.codex'), { recursive: true })
    // Seed the answer so app lookup re-probes only the version, avoiding another hooks/list.
    memoizeCodexHookAnswer(binary!, fingerprintCodex(binary!)!, command(), answer)
    startCodexHookHashLookup(Promise.resolve())
    expect((await new CodexHookService().install(accountHome())).state).toBe('installed')
  }

  async function orcaListings(codexHome: string): Promise<CodexListedHook[]> {
    // Keep project hooks out of the listing.
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

    // Require every copy so missing listings cannot make the hash cross-check vacuous.
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
    // Pinned Codex versions must hash every managed event.
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
        // Close stdin so codex exec finishes reading its prompt.
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
      const { screen, posts } = await runCodexTui(accountHome(), true)
      expect(screen).toMatch(/eeds?review/i)
      expect(posts).toEqual([])
    }
  )

  describe('~/.codex', () => {
    // Symlink HOME to exercise both trust-key spellings.
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
      // Keep project hooks out of the listing.
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
      // Verify Codex can still load the config and start.
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

  async function runCodexTui(
    codexHome: string | null = accountHome(),
    expectReview = false
  ): Promise<{ screen: string; posts: string[] }> {
    const codexHomeEnv = codexHome ? { CODEX_HOME: codexHome } : {}
    const posts: string[] = []
    const control = mkdtempSync(join(root, 'tui-control-'))
    const receiver = await listen(recordPosts(posts, control))
    const model = await startMockResponses()
    // Codex 0.158 requires real project paths for trust, including under symlinked HOME.
    const workdir = join(realpathSync(home), 'tui-work')
    mkdirSync(workdir, { recursive: true })
    const out = join(home, 'tui.out')
    const help = await execFileAsync(binary!, ['--help'], {
      env: { PATH: process.env.PATH, HOME: home, ...codexHomeEnv }
    })
    try {
      const run = execFileAsync(
        'python3',
        [
          '-c',
          PTY_DRIVER,
          out,
          'say hi',
          workdir,
          control,
          expectReview ? 'review' : 'turn',
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
          maxBuffer: 64 * 1024 * 1024,
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
      const composer = createCodexComposerReadyScanner()
      const decoder = new StringDecoder('utf8')
      let painted = ''
      const text = createTerminalEscapeScanner({
        onCsi: () => {},
        onText: (chunk) => {
          painted = (painted + chunk).slice(-16_384)
        }
      })
      const mark = (name: string): void => {
        const file = join(control, name)
        if (!existsSync(file)) {
          writeFileSync(file, '')
        }
      }
      run.child.stdout?.on('data', (bytes: Buffer) => {
        const chunk = decoder.write(bytes)
        const ready = composer.observe(chunk).ready
        text.observe(chunk)
        const folded = painted.replace(/\s+/g, '')
        if (/eeds?review/i.test(folded)) {
          mark('review-started')
        }
        if (/\d+hooks?n?eeds?reviewbeforeitcanrun/i.test(folded)) {
          mark('review-table')
        }
        if (ready && /\b(?:default|minimal|low|medium|high|xhigh)\s*·/.test(painted)) {
          mark('ready')
        }
        if (folded.includes('•hi') && ready) {
          mark('assistant-painted')
        }
      })
      await run
    } finally {
      model.close()
      receiver.close()
    }
    const screen = stripAnsiEscapeSequences(readFileSync(out, 'utf-8')).replace(/\s+/g, '')
    return { screen, posts }
  }
})

// Review screens exist only in the TUI; codex exec cannot exercise them.
const PTY_DRIVER = `
import os, pty, sys, time, select, signal, struct, fcntl, termios
out, prompt, cwd = sys.argv[1], sys.argv[2], sys.argv[3]
control, expected = sys.argv[4], sys.argv[5]
cmd = sys.argv[sys.argv.index('--') + 1:]
def send(data):
    os.write(fd, data)
buf = b''
def present(name):
    return os.path.isfile(os.path.join(control, name))
def pump(sec, done=None):
    global buf
    end = time.monotonic() + sec
    while time.monotonic() < end:
        if done and done(): return True
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: d = os.read(fd, 65536)
            except OSError: return False
            if not d: return False
            buf += d
            os.write(sys.stdout.fileno(), d)
            if b'\\x1b[6n' in d: send(b'\\x1b[1;1R')
    return bool(done and done())
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd); os.execv(cmd[0], cmd)
try:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    start = 'review-started' if expected == 'review' else 'ready'
    if not pump(8, lambda: present(start)):
        raise RuntimeError('Codex did not paint its expected startup state within 8 seconds')
    send(prompt.encode()); time.sleep(0.5); send(b'\\r')
    if expected == 'review':
        done = lambda: present('review-table') and not present('stop')
    else:
        done = lambda: present('stop') and present('assistant-painted')
    if not pump(10, done):
        raise RuntimeError('Codex did not deliver/paint its expected turn or review within 10 seconds')
finally:
    try:
        for _ in range(3):
            try: send(b'\\x03')
            except OSError: break
            pump(1)
    finally:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        finally:
            waited_pid, status = os.waitpid(pid, 0)
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

function recordPosts(posts: string[], control?: string): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = []
    if (control) {
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
    }
    request.resume()
    request.on('end', () => {
      posts.push(request.url ?? '')
      if (control && request.url === '/hook/codex') {
        const raw = Buffer.concat(chunks).toString('utf8')
        const form = new URLSearchParams(raw)
        try {
          const payload: unknown = JSON.parse(form.get('payload') ?? raw)
          if (
            typeof payload === 'object' &&
            payload !== null &&
            'hook_event_name' in payload &&
            payload.hook_event_name === 'Stop'
          ) {
            response.once('finish', () => writeFileSync(join(control, 'stop'), raw))
          }
        } catch {
          /* A malformed owner payload must not satisfy the delivery gate. */
        }
      }
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
