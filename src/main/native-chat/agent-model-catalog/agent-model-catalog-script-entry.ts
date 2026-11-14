import { NODE_INTERPRETER_OPTIONS_WITH_VALUE } from '../../../shared/node-interpreter-options'

const NODE_FLAGS = new Set([
  '--no-warnings',
  '--trace-warnings',
  '--enable-source-maps',
  '--preserve-symlinks',
  '--preserve-symlinks-main'
])
const PYTHON_FLAGS = new Set(['-u', '-B', '-E', '-s', '-S', '-I', '-O', '-OO', '-q'])
const PYTHON_VALUES = new Set(['-W', '-X'])
const DENO_FLAGS = new Set(['-A', '--allow-all', '--no-prompt'])
const DENO_VALUES = new Set(['-c', '--config', '--import-map'])
const DENO_PERMISSIONS = new Set([
  '--allow-read',
  '--allow-write',
  '--allow-net',
  '--allow-env',
  '--allow-run',
  '--allow-ffi',
  '--allow-sys',
  '--allow-import',
  '--deny-read',
  '--deny-write',
  '--deny-net',
  '--deny-env',
  '--deny-run',
  '--deny-ffi',
  '--deny-sys'
])

function scriptFile(token: string | undefined, deno = false): string | undefined {
  if (!token || token === '-') {
    return undefined
  }
  return deno && /^[a-z][a-z\d+.-]*:/i.test(token) && !/^[a-z]:[\\/]/i.test(token)
    ? undefined
    : token
}

/** Unknown option arity cannot safely identify a file; those commands use explicit Refresh. */
export function agentModelCatalogScriptEntry(
  interpreter: string,
  args: readonly string[]
): string | undefined {
  const node = /^(node|nodejs)$/.test(interpreter)
  const python = /^python\d*(?:\.\d+)?$/.test(interpreter)
  const deno = interpreter === 'deno'
  if (!node && !python && !deno) {
    if (!/^(bun|ruby|sh|bash|zsh)$/.test(interpreter)) {
      return undefined
    }
    const operand = interpreter === 'bun' && args[0] === 'run' ? args[1] : args[0]
    return operand?.startsWith('-') || (interpreter === 'bun' && operand === 'eval')
      ? undefined
      : scriptFile(operand)
  }
  if (deno && args[0] !== 'run') {
    return undefined
  }
  const flags = node ? NODE_FLAGS : python ? PYTHON_FLAGS : DENO_FLAGS
  const values = node ? NODE_INTERPRETER_OPTIONS_WITH_VALUE : python ? PYTHON_VALUES : DENO_VALUES
  for (let index = deno ? 1 : 0; index < args.length; index += 1) {
    const token = args[index]!
    if (!token) {
      return undefined
    }
    if (token === '--') {
      return scriptFile(args[index + 1], deno)
    }
    if (!token.startsWith('-')) {
      return node && token === 'inspect' ? undefined : scriptFile(token, deno)
    }
    if (flags.has(token)) {
      continue
    }
    if (values.has(token)) {
      const value = args[++index]
      if (!value || value.startsWith('-')) {
        return undefined
      }
      continue
    }
    const equals = token.indexOf('=')
    const name = equals === -1 ? token : token.slice(0, equals)
    if (token.startsWith('--') && values.has(name) && equals !== -1) {
      if (equals === token.length - 1) {
        return undefined
      }
      continue
    }
    if (deno && DENO_PERMISSIONS.has(name)) {
      if (equals === token.length - 1) {
        return undefined
      }
      continue
    }
    if (python && /^-[WX].+/.test(token)) {
      continue
    }
    return undefined
  }
  return undefined
}
