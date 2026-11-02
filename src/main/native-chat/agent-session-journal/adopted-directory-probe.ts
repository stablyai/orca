import { dirname } from 'node:path'
import { runProcess } from '@orca/process-host'
import { pickAllowedEnv, RUNTIME_ENV_ALLOWLIST } from '../../ai-vault/session-scanner-service-env'

export const ADOPTED_DIRECTORY_PROBE_TIMEOUT_MS = 5_000
export const ADOPTED_DIRECTORY_PROBE_MAX_OUTPUT_BYTES = 4_096

// Static source travels in both host bundles; paths stay stdin data, never executable text.
export const ADOPTED_DIRECTORY_PROBE_SOURCE = String.raw`
const {realpath} = require('node:fs/promises');
const {isAbsolute, dirname, sep} = require('node:path');
// Match normalizeRuntimePathForComparison; never resolve or normalize source dot segments.
function comparison(raw) {
  const value = raw.normalize('NFC');
  const windows = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//');
  let path = windows ? value.replace(/\\/g, '/') : value;
  path = path.replace(/\/+/g, '/');
  if (windows && (value.startsWith('\\\\') || value.startsWith('//'))) path = '/' + path;
  if (path !== '/' && !/^[A-Za-z]:\/$/.test(path)) path = path.replace(/\/+$/, '');
  const wsl = path.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/[\s\S]*)?$/i);
  if (wsl) return '//wsl/' + wsl[1].toLowerCase() + (wsl[2] || '');
  return windows ? path.toLowerCase() : path;
}
async function main() {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  if (request.version !== 1 || typeof request.workspaceCwd !== 'string' ||
      typeof request.sourceCwd !== 'string' || !isAbsolute(request.workspaceCwd) ||
      /^[/\\]{2}wsl(?:\.localhost|\$)[/\\]/i.test(request.workspaceCwd)) throw Error('invalid request');
  const workspace = request.workspaceCwd;
  const source = comparison(request.sourceCwd.trim());
  let prefix = workspace;
  let unavailable = false;
  for (;;) {
    const resolved = await realpath(prefix).catch(() => { unavailable = true; return null; });
    const suffix = workspace.slice(prefix.length);
    const candidate = resolved && (suffix
      ? (resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved) +
        (suffix.startsWith(sep) || (sep === '\\' && suffix.startsWith('/')) ? '' : sep) + suffix
      : resolved);
    if (candidate && comparison(candidate) === source) {
      process.stdout.write(JSON.stringify({version:1, matched:true}));
      return;
    }
    const parent = dirname(prefix);
    if (parent === prefix) break;
    prefix = parent;
  }
  if (unavailable) throw Error('unavailable directory verification');
  process.stdout.write(JSON.stringify({version:1, matched:false}));
}
main().catch(() => { process.exitCode = 1; });
`

/** Logical requests finish independently; process-host retains each child until its close callback. */
export class AdoptedDirectoryProbes {
  private readonly owned = new Set<object>()

  get ownedCount(): number {
    return this.owned.size
  }

  async matches(workspaceCwd: string, sourceCwd: string, signal?: AbortSignal): Promise<boolean> {
    const job = {}
    this.owned.add(job)
    const env = pickAllowedEnv(RUNTIME_ENV_ALLOWLIST, process.env, process.platform)
    env.ELECTRON_RUN_AS_NODE = '1'
    try {
      const result = await runProcess({
        program: process.execPath,
        args: ['-e', ADOPTED_DIRECTORY_PROBE_SOURCE],
        cwd: dirname(process.execPath),
        env,
        input: JSON.stringify({ version: 1, workspaceCwd, sourceCwd }),
        signal,
        timeoutMs: ADOPTED_DIRECTORY_PROBE_TIMEOUT_MS,
        maxOutputBytes: ADOPTED_DIRECTORY_PROBE_MAX_OUTPUT_BYTES,
        killOnOutputLimit: true,
        onChildTerminated: () => this.owned.delete(job)
      })
      if (signal?.aborted || result.timedOut || result.code !== 0 || result.outputTruncated) {
        throw new Error('The conversation directory could not be verified. Try Resume again.')
      }
      const value: unknown = JSON.parse(result.stdout)
      if (
        !value ||
        typeof value !== 'object' ||
        !('version' in value) ||
        value.version !== 1 ||
        !('matched' in value) ||
        typeof value.matched !== 'boolean'
      ) {
        throw new Error('Invalid directory verification response')
      }
      return value.matched
    } catch {
      throw new Error('The conversation directory could not be verified. Try Resume again.')
    }
  }
}

export const adoptedDirectoryProbes = new AdoptedDirectoryProbes()
