import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// A scripted stand-in for `gitExecFileAsync` that the spare checkout suites drive: each git command
// a spare build, handover or plain add runs is recorded, and the slow or failing ones are scripted.
export const OID_A = 'a'.repeat(40)
export const OID_B = 'b'.repeat(40)

/** How the spare's `reset --hard` behaves once started. */
export type ResetMode =
  | 'resolve'
  /** Killed by the abort signal, like a real child. */
  | 'hang'
  /** Ignores the abort entirely; only `releaseResets()` ends it. */
  | 'hang-ignoring-abort'
  /** Exits 0 the moment it is aborted. */
  | 'resolve-on-abort'

type GitCall = { args: string[]; cwd?: string; signal?: AbortSignal; admissionTier?: string }

export type FakeGitScript = {
  refs: Map<string, string>
  resetMode: ResetMode
  hookRunSupported: boolean
  hookFile: string
  hooksDir: string
  /** When set, the spare's `worktree add` waits for it. */
  spareAddGate?: Promise<void>
  failing: Set<'move' | 'move-back' | 'symbolic-ref' | 'unlock' | 'remove' | 'hook'>
  calls: GitCall[]
  resetSignals: AbortSignal[]
}

export function createFakeGitScript(): FakeGitScript {
  return {
    refs: new Map([['refs/remotes/origin/main', OID_A]]),
    resetMode: 'resolve',
    hookRunSupported: true,
    hookFile: '.git/hooks/post-checkout',
    hooksDir: '/repo/.git/hooks',
    failing: new Set(),
    calls: [],
    resetSignals: []
  }
}

let pendingResets: (() => void)[] = []

/** Ends every `reset` held by `hang-ignoring-abort` with success. */
export function releaseResets(): void {
  const resets = pendingResets
  pendingResets = []
  for (const release of resets) {
    release()
  }
}

const ok = { stdout: '', stderr: '' }

function fail(message: string): Promise<never> {
  return Promise.reject(Object.assign(new Error(message), { stderr: message }))
}

function runReset(script: FakeGitScript, signal: AbortSignal | undefined): Promise<typeof ok> {
  const abortSignal = signal ?? new AbortController().signal
  script.resetSignals.push(abortSignal)
  if (script.resetMode === 'resolve') {
    return Promise.resolve(ok)
  }
  return new Promise((resolve, reject) => {
    if (script.resetMode === 'hang-ignoring-abort') {
      pendingResets.push(() => resolve(ok))
      return
    }
    abortSignal.addEventListener('abort', () =>
      script.resetMode === 'hang' ? reject(new Error('killed')) : resolve(ok)
    )
  })
}

/** Writes the `.git` marker `worktree move` leaves at its destination, naming the spare's admin entry. */
async function moveSpare(from: string, to: string): Promise<typeof ok> {
  // Spare ids are `<pid>-<uuid>`; a move back names the spare at its destination.
  const name = (path: string): string =>
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  const admin = name(from).includes('-') ? name(from) : name(to)
  await mkdir(to, { recursive: true })
  await writeFile(join(to, '.git'), `gitdir: /repo/.git/worktrees/${admin}\n`)
  return ok
}

function runWorktree(script: FakeGitScript, args: string[]): Promise<typeof ok> {
  const sub = args[1]
  if (sub === 'add' && args.includes('--detach') && script.spareAddGate) {
    return script.spareAddGate.then(() => ok)
  }
  if (sub === 'move') {
    const [from, to] = args.slice(-2)
    const back = to?.includes('.orca-preparing')
    return script.failing.has(back ? 'move-back' : 'move')
      ? fail('move failed')
      : moveSpare(from ?? '', to ?? '')
  }
  if (
    (sub === 'unlock' && script.failing.has('unlock')) ||
    (sub === 'remove' && script.failing.has('remove'))
  ) {
    return fail(`${sub} failed`)
  }
  return Promise.resolve(ok)
}

export function fakeGit(script: FakeGitScript) {
  return (rawArgs: string[], options: Omit<GitCall, 'args'> = {}): Promise<typeof ok> => {
    // Global options (`-c k=v`, `--work-tree <path>`) come before the command; record the rest.
    const globals = new Set(['-c', '--work-tree'])
    const args = rawArgs.filter(
      (arg, index) => !globals.has(arg) && !globals.has(rawArgs[index - 1] ?? '')
    )
    script.calls.push({ args, ...options })
    if (args[0] === 'rev-parse') {
      if (args.includes('--git-path')) {
        const hooks = args.at(-1) === 'hooks' ? script.hooksDir : script.hookFile
        return Promise.resolve({ stdout: `${hooks}\n`, stderr: '' })
      }
      const oid = script.refs.get((args.at(-1) ?? '').replace(/\^\{commit\}$/, ''))
      return oid ? Promise.resolve({ stdout: `${oid}\n`, stderr: '' }) : fail('unknown revision')
    }
    if (args[0] === 'hook') {
      if (!script.hookRunSupported) {
        return fail("git: 'hook' is not a git command. See 'git --help'.")
      }
      return args.includes('post-checkout') && script.failing.has('hook')
        ? fail('hook failed')
        : Promise.resolve(ok)
    }
    if (args[0] === 'reset') {
      return runReset(script, options.signal)
    }
    if (args[0] === 'worktree') {
      return runWorktree(script, args)
    }
    if (args[0] === 'symbolic-ref' && script.failing.has('symbolic-ref')) {
      return fail('symbolic-ref failed')
    }
    return Promise.resolve(ok)
  }
}

export function gitCommands(script: FakeGitScript, match: (args: string[]) => boolean): GitCall[] {
  return script.calls.filter((call) => match(call.args))
}

export const isPlainAdd = (args: string[]): boolean =>
  args[0] === 'worktree' && args[1] === 'add' && args.includes('-b')
export const isSpareAdd = (args: string[]): boolean =>
  args[0] === 'worktree' && args[1] === 'add' && args.includes('--detach')
export const isRemove = (args: string[]): boolean => args[0] === 'worktree' && args[1] === 'remove'
