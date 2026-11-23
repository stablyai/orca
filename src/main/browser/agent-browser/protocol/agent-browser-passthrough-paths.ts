import { resolveCallerLocalPath } from '../../../../shared/file-access/caller-local-path'
import { splitAgentBrowserCommandLine } from './agent-browser-passthrough-arguments'

/** Where a CLI on this machine ran; a paired caller sends neither, so its words pass as typed. */
export type AgentBrowserPassthroughCaller = { cwd?: string; wslDistro?: string }

// Why: the helper's daemon resolves a relative file operand against its own cwd (wherever it was
// first spawned), so `exec screenshot ./x.png` must reach it as the caller's absolute path.
type PathOperands = {
  /** Options whose next token is their value, so it isn't a positional operand. */
  valueOptions?: readonly string[]
  /** Options whose value is a file. */
  pathOptions?: readonly string[]
  /** Indexes (among positional operands after the command) that are files. */
  positional?: (operands: readonly string[]) => readonly number[]
}

// A lone `#photo.png` or `[src$=.png]` is still a selector.
const IMAGE_FILE = /^(?![#[@]|\.[^./]).*\.(png|jpe?g|webp)$/i

const PATH_OPERANDS: Record<string, PathOperands> = {
  // `screenshot [selector] [path]`: a lone operand is a path only when it names an image.
  screenshot: {
    valueOptions: ['--threshold'],
    positional: (ops) => (ops.length >= 2 ? [1] : IMAGE_FILE.test(ops[0] ?? '') ? [0] : [])
  },
  pdf: { positional: () => [0] },
  download: { positional: () => [1] },
  upload: { positional: (ops) => ops.map((_, index) => index).slice(1) },
  trace: { positional: (ops) => (ops[0] === 'stop' ? [1] : []) },
  profiler: {
    valueOptions: ['--categories'],
    positional: (ops) => (ops[0] === 'stop' ? [1] : [])
  },
  record: {
    valueOptions: ['--fps', '--contact-sheet-threshold'],
    positional: (ops) => (ops[0] === 'start' || ops[0] === 'restart' ? [1] : [])
  },
  network: {
    valueOptions: ['--content'],
    positional: (ops) => (ops[0] === 'har' && ops[1] === 'stop' ? [2] : [])
  },
  wait: { pathOptions: ['--download'] },
  diff: { pathOptions: ['--baseline', '-b', '--output', '-o'] },
  cookies: { pathOptions: ['--curl'] }
}

export function resolveCallerPassthroughPaths(
  args: readonly string[],
  caller: AgentBrowserPassthroughCaller | undefined
): string[] {
  const cwd = caller?.cwd
  return cwd
    ? resolveAgentBrowserPassthroughPaths(args, (path) =>
        resolveCallerLocalPath(path, cwd, caller.wslDistro ?? null)
      )
    : [...args]
}

/** Rewrites a raw command's file operands with `resolvePath`; other words pass unchanged. */
export function resolveAgentBrowserPassthroughPaths(
  args: readonly string[],
  resolvePath: (path: string) => string
): string[] {
  const [command, ...rest] = args
  if (command === 'batch') {
    return [command, ...rest.map((step) => resolveBatchStep(step, resolvePath))]
  }
  const grammar = command ? PATH_OPERANDS[command] : undefined
  if (!grammar) {
    return [...args]
  }
  const resolved = [...args]
  const positions: number[] = []
  for (let index = 1; index < args.length; index += 1) {
    const word = args[index]!
    if (grammar.pathOptions?.includes(word)) {
      const value = args[index + 1]
      if (value !== undefined && !value.startsWith('-')) {
        resolved[index + 1] = resolveFileWord(value, resolvePath)
        index += 1
      }
    } else if (grammar.valueOptions?.includes(word)) {
      index += 1
    } else if (!word.startsWith('-')) {
      positions.push(index)
    }
  }
  const operands = positions.map((index) => args[index]!)
  for (const operandIndex of grammar.positional?.(operands) ?? []) {
    const index = positions[operandIndex]
    if (index !== undefined) {
      resolved[index] = resolveFileWord(args[index]!, resolvePath)
    }
  }
  return resolved
}

// `~` is the helper's own home expansion.
function resolveFileWord(word: string, resolvePath: (path: string) => string): string {
  return word === '' || word.startsWith('~') ? word : resolvePath(word)
}

// A step is a command line agent-browser splits itself; requote only when a path changed.
function resolveBatchStep(step: string, resolvePath: (path: string) => string): string {
  if (step === '--bail') {
    return step
  }
  const words = splitAgentBrowserCommandLine(step)
  const resolved = resolveAgentBrowserPassthroughPaths(words, resolvePath)
  return resolved.every((word, index) => word === words[index])
    ? step
    : resolved.map((word) => `"${word.replace(/["\\]/g, '\\$&')}"`).join(' ')
}
