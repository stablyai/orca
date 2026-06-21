// Why: lets the renderer add a custom OpenAI-compatible provider profile to the
// jcode CLI (base URL + model + API key) and list the built-in providers. The
// jcode CLI already persists a `[providers.<name>]` profile and stores the key
// in its private env file via `jcode provider add ... --api-key-stdin`; this
// module is the thin, safe bridge.
//
// SECURITY: the API key is written to the child's STDIN (never passed as an
// argv flag, which would leak via `ps`/process listing) and is never logged.
import { spawn } from 'node:child_process'
import { ipcMain } from 'electron'
import {
  JCODE_MODELS_LIST_CHANNEL,
  JCODE_PROVIDERS_ADD_CHANNEL,
  JCODE_PROVIDERS_LIST_CHANNEL,
  type JcodeCustomProvider,
  type JcodeModelCatalog,
  type JcodeModelRoute,
  type JcodeProviderActionResult,
  type JcodeProviderAddArgs,
  type JcodeProviderAuth
} from '../../shared/jcode-chat-types'
import { resolveJcodeBin } from '../jcode/jcode-binary'

const NAME_RE = /^[a-zA-Z0-9_-]+$/
const ALLOWED_AUTH: readonly JcodeProviderAuth[] = ['bearer', 'api-key', 'none']

function fail(error: string): JcodeProviderActionResult {
  return { ok: false, error }
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    // Allow http(s); http only for localhost-style custom gateways.
    if (url.protocol === 'https:') {
      return true
    }
    if (url.protocol === 'http:') {
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    }
    return false
  } catch {
    return false
  }
}

/** Validate the add args. Returns null when valid, else an error message. */
function validateAddArgs(args: JcodeProviderAddArgs): string | null {
  if (!args || typeof args !== 'object') {
    return 'Invalid request.'
  }
  const name = args.name?.trim()
  if (!name || !NAME_RE.test(name)) {
    return 'Profile name must be non-empty and contain only letters, numbers, "-" or "_".'
  }
  const baseUrl = args.baseUrl?.trim()
  if (!baseUrl || !isHttpsUrl(baseUrl)) {
    return 'Base URL must be a valid https URL (e.g. https://llm.example.com/v1).'
  }
  const model = args.model?.trim()
  if (!model) {
    return 'Model id is required.'
  }
  if (args.auth !== undefined && !ALLOWED_AUTH.includes(args.auth)) {
    return 'Auth must be one of bearer, api-key, or none.'
  }
  return null
}

/** Spawn jcode and resolve with {code, stdout, stderr}. Optionally write a
 *  secret to stdin (used for --api-key-stdin). The secret is NEVER part of argv
 *  and is NEVER logged. */
function runJcode(
  argv: string[],
  stdin?: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(resolveJcodeBin(), argv, { env: process.env })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error: Error) => reject(error))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    if (stdin !== undefined) {
      child.stdin?.write(stdin)
    }
    child.stdin?.end()
  })
}

async function addProvider(args: JcodeProviderAddArgs): Promise<JcodeProviderActionResult> {
  const validationError = validateAddArgs(args)
  if (validationError) {
    return fail(validationError)
  }
  const name = args.name.trim()
  const baseUrl = args.baseUrl.trim()
  const model = args.model.trim()
  const auth: JcodeProviderAuth = args.auth ?? 'bearer'
  const hasKey = typeof args.apiKey === 'string' && args.apiKey.length > 0

  // `provider add <NAME> --base-url <URL> --model <MODEL> [--auth ...]
  //   [--auth-header H] [--api-key-stdin | --no-api-key] --json --overwrite`
  const argv = [
    'provider',
    'add',
    name,
    '--base-url',
    baseUrl,
    '--model',
    model,
    '--auth',
    auth,
    '--json',
    '--overwrite',
    '--no-update'
  ]
  if (args.authHeader?.trim()) {
    argv.push('--auth-header', args.authHeader.trim())
  }
  if (hasKey) {
    argv.push('--api-key-stdin')
  } else {
    argv.push('--no-api-key')
  }

  let result: { code: number | null; stdout: string; stderr: string }
  try {
    result = await runJcode(argv, hasKey ? args.apiKey : undefined)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  if (result.code !== 0) {
    return fail(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `jcode provider add exited with code ${result.code === null ? 'null' : String(result.code)}`
    )
  }

  // The non-secret profile we persist on the orca side regardless of the exact
  // shape jcode's --json returns (we already validated the inputs).
  const provider: JcodeCustomProvider = { name, baseUrl, model, auth }
  return { ok: true, provider }
}

type BuiltinProvider = {
  id: string
  display_name?: string
  detail?: string
  recommended?: boolean
}

async function listProviders(): Promise<{
  ok: boolean
  error?: string
  builtins: BuiltinProvider[]
}> {
  let result: { code: number | null; stdout: string; stderr: string }
  try {
    result = await runJcode(['provider', 'list', '--json', '--no-update'])
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      builtins: []
    }
  }
  if (result.code !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || `jcode provider list exited with code ${result.code}`,
      builtins: []
    }
  }
  try {
    const parsed = JSON.parse(result.stdout) as { providers?: BuiltinProvider[] }
    return { ok: true, builtins: Array.isArray(parsed.providers) ? parsed.providers : [] }
  } catch {
    return { ok: true, builtins: [] }
  }
}

/** Shell `jcode model list --json` and return the real model catalog (provider,
 *  selected model, full model list, and per-model availability routes) that the
 *  composer's detailed picker renders. We use the AUTO catalog (no `-p`) on
 *  purpose: it returns the usable models for the resolved provider PLUS the
 *  cross-provider routes with availability, and it never trips jcode's
 *  interactive credential-approval gate that `-p claude` would. */
async function listModels(): Promise<JcodeModelCatalog> {
  let result: { code: number | null; stdout: string; stderr: string }
  try {
    result = await runJcode(['model', 'list', '--json', '--no-update'])
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      models: [],
      routes: []
    }
  }
  if (result.code !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || `jcode model list exited with code ${result.code}`,
      models: [],
      routes: []
    }
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      provider?: string
      selected_model?: string
      models?: string[]
      routes?: { provider?: string; model?: string; method?: string; available?: boolean }[]
    }
    const routes: JcodeModelRoute[] = Array.isArray(parsed.routes)
      ? parsed.routes
          .filter(
            (r): r is { provider: string; model: string; method?: string; available?: boolean } =>
              typeof r?.provider === 'string' && typeof r?.model === 'string'
          )
          .map((r) => ({
            provider: r.provider,
            model: r.model,
            method: typeof r.method === 'string' ? r.method : undefined,
            available: r.available === true
          }))
      : []
    return {
      ok: true,
      provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
      selectedModel: typeof parsed.selected_model === 'string' ? parsed.selected_model : undefined,
      models: Array.isArray(parsed.models)
        ? parsed.models.filter((m) => typeof m === 'string')
        : [],
      routes
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to parse jcode model list output.',
      models: [],
      routes: []
    }
  }
}

export function registerJcodeProviderHandlers(): void {
  ipcMain.removeHandler(JCODE_PROVIDERS_ADD_CHANNEL)
  ipcMain.handle(JCODE_PROVIDERS_ADD_CHANNEL, (_event, raw: unknown) =>
    addProvider(raw as JcodeProviderAddArgs)
  )

  ipcMain.removeHandler(JCODE_PROVIDERS_LIST_CHANNEL)
  ipcMain.handle(JCODE_PROVIDERS_LIST_CHANNEL, () => listProviders())

  ipcMain.removeHandler(JCODE_MODELS_LIST_CHANNEL)
  ipcMain.handle(JCODE_MODELS_LIST_CHANNEL, () => listModels())
}
