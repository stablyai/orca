import * as readline from 'node:readline/promises'
import type {
  RuntimeAccountAddStarted,
  RuntimeAccountPollAddResult,
  RuntimeAccountProvider
} from '../../shared/runtime-types'
import { formatAccountAddResult, formatAccountAddStarted } from '../accounts-format'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import type { RuntimeClient, RuntimeRpcSuccess } from '../runtime-client'

// Why: must stay >= the main process's worst-case login duration + a grace
// margin, or the CLI gives up before the server does. codex now runs
// CodexAccountService's DEVICE_AUTH_LOGIN_TIMEOUT_MS (16 * 60 * 1000 = 960_000)
// since accounts.addCodex always requests device-code auth for this headless
// path; 970_000 = 960s + 10s grace. claude runs ClaudeAccountService's
// REMOTE_LOGIN_TIMEOUT_MS (16 * 60 * 1000 = 960_000) THEN STATUS_TIMEOUT_MS
// (20_000) sequentially (see src/main/claude-accounts/service.ts) since
// accounts.addClaude always requests remoteAuth for this headless path — the
// user must open the login URL (possibly on another device), complete OAuth,
// and paste the resulting code back, which needs far more wall-clock time
// than the desktop same-machine flow; the worst case is 980_000;
// 990_000 = 980s + 10s grace. Keep this in sync if either service's
// timeouts change.
const ADD_ACCOUNT_TIMEOUT_MS: Record<RuntimeAccountProvider, number> = {
  codex: 16 * 60 * 1000 + 10_000,
  claude: 16 * 60 * 1000 + 20_000 + 10_000
}
const POLL_WINDOW_MS = 15_000
const POLL_CLIENT_GRACE_MS = 5_000
const LOGIN_URL_PATTERN = /https?:\/\/\S+/g
// Why: codex/claude login often print a local OAuth callback server URL
// (e.g. "Starting local server on http://localhost:1455") before the actual
// browser auth URL. A loopback address only resolves on the machine running
// the server, so it must never win over a real external auth URL here.
const LOOPBACK_LOGIN_URL_PATTERN =
  /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i
// Why: Codex's device-auth output colors the URL/code with ANSI SGR escapes
// (e.g. "\x1b[94mhttps://...\x1b[0m") with no whitespace before the reset
// code, so LOGIN_URL_PATTERN's \S+ would otherwise swallow "\x1b[0m" into the
// extracted URL. Only extraction regexes need clean text — the raw stream
// forwarded to the user's terminal must keep its real colors.
// eslint-disable-next-line no-control-regex -- intentionally matches the ESC control byte to strip ANSI SGR sequences
const ANSI_SGR_PATTERN = /\x1b\[[0-9;]*m/g
// Why: Claude CLI wraps the printed login URL in an OSC 8 terminal hyperlink
// (ESC ] 8 ; ; <uri> BEL <visible text> ESC ] 8 ; ; BEL), a different escape
// family (ESC ]) than ANSI_SGR_PATTERN's CSI (ESC [) sequences, so it slips
// through unstripped otherwise. The <uri> here duplicates the visible text,
// so stripping just the two OSC markers (open+close) also removes the whole
// invisible opening sequence — <uri> included — leaving exactly one clean
// visible URL behind rather than two concatenated copies.
// eslint-disable-next-line no-control-regex -- intentionally matches ESC/BEL control bytes to strip OSC 8 hyperlink sequences
const OSC_HYPERLINK_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// Why: matches Codex's observed device-code shape (e.g. "7UNS-MDSUA") without
// over-fitting to an exact segment length, since Codex generates this format.
const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{3,8}-[A-Z0-9]{3,8}\b/
const ONE_TIME_CODE_PHRASE_PATTERN = /one-time code/i
const DEVICE_CODE_SEARCH_WINDOW_CHARS = 200
// Why: matches Claude CLI's observed "Paste code here if prompted >" prompt;
// kept loose (not the exact sentence) since Claude CLI wording could vary
// slightly across versions.
const PASTE_CODE_PROMPT_PATTERN = /paste code/i

function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR_PATTERN, '').replace(OSC_HYPERLINK_PATTERN, '')
}

function extractLoginUrl(outputTail: string): string | undefined {
  const matches = stripAnsi(outputTail).match(LOGIN_URL_PATTERN) ?? []
  const cleaned = matches.map((url) => url.replace(/[).,\]}'"]+$/, ''))
  // Why: prefer the first non-loopback URL (the real auth link); fall back to
  // whatever matched if every candidate happens to be a loopback address.
  return cleaned.find((url) => !LOOPBACK_LOGIN_URL_PATTERN.test(url)) ?? cleaned[0]
}

// Why: only fires for Codex's device-auth flow, which is the only login
// output that ever prints a "one-time code" phrase; Claude's output has no
// equivalent, so this must never false-positive there.
function extractDeviceCode(outputTail: string): string | undefined {
  const cleaned = stripAnsi(outputTail)
  const phraseMatch = ONE_TIME_CODE_PHRASE_PATTERN.exec(cleaned)
  if (!phraseMatch) {
    return undefined
  }
  const searchStart = phraseMatch.index + phraseMatch[0].length
  const window = cleaned.slice(searchStart, searchStart + DEVICE_CODE_SEARCH_WINDOW_CHARS)
  return DEVICE_CODE_PATTERN.exec(window)?.[0]
}

// Why: the registry caps outputTail and truncates from the front once a
// login prints more than OUTPUT_TAIL_MAX_CHARS, so a plain length-based
// "already printed" offset breaks the moment truncation kicks in — the tail
// length stops growing and further output is silently never printed. Finding
// the overlap between what we last saw and the new tail lets us print only
// the genuinely new suffix even after front-truncation shifts the buffer.
function findOverlapLength(previousTail: string, nextTail: string): number {
  const maxOverlap = Math.min(previousTail.length, nextTail.length)
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (previousTail.slice(previousTail.length - overlap) === nextTail.slice(0, overlap)) {
      return overlap
    }
  }
  return 0
}

function computeNewOutputText(previousTail: string, nextTail: string): string {
  return nextTail.slice(findOverlapLength(previousTail, nextTail))
}

// Why: thrown message text for PendingAccountLoginRegistry.submitInput() once
// a login has already settled (see src/main/accounts/pending-account-login-
// registry.ts) — matched below to recognize the now-common "the login
// finished on its own while the user was still typing" outcome rather than
// treating it as a real failure.
const LOGIN_ALREADY_SETTLED_MESSAGE = 'That account login no longer exists.'

type PendingPastePrompt = {
  /** Resolves with the trimmed pasted code, or undefined if the user gave up,
   *  stdin isn't interactive, or the prompt was abandoned. Never rejects. */
  promise: Promise<string | undefined>
  /** Closes the underlying readline interface if it is still open. Safe to
   *  call multiple times (including after the prompt already settled). */
  abandon: () => void
}

// Why: Claude's headless login has no local browser to auto-complete OAuth,
// so the user may need to paste the code Claude's own auth page shows back
// into this CLI process, which then relays it to the login child process's
// stdin on the server via accounts.submitLoginInput. Reads --json's prompt
// from stderr so stdout stays clean JSON for scripts/tools parsing it.
//
// Why not awaited by its caller: Claude's CLI typically completes the login
// on its own within seconds of the user authorizing in the browser — the
// "paste code" prompt is a rare fallback, not the common path — so blocking
// the poll loop on this prompt would delay noticing a login that already
// finished. Callers kick this off and keep polling; `abandon()` lets them
// release stdin once the login settles even if nothing was ever typed.
function promptForPastedCode(json: boolean): PendingPastePrompt {
  // Why: readline/promises' rl.question() never settles (resolves or rejects)
  // when stdin has no data and stays open — confirmed by testing against a
  // closed fd, /dev/null, and an open-but-silent pipe — so a non-interactive
  // stdin (CI, `< /dev/null`, piped input) would wedge this command forever
  // instead of hitting the catch below. Skip the prompt entirely in that case.
  if (!process.stdin.isTTY) {
    const message = 'Cannot prompt for the pasted code: stdin is not an interactive terminal.'
    process.stderr.write(`${message}\n`)
    return { promise: Promise.resolve(undefined), abandon: () => {} }
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: json ? process.stderr : process.stdout
  })
  const promise = rl
    .question('Paste the code from the browser here: ')
    .then((answer) => answer.trim() || undefined)
    .catch(() => undefined)
    .finally(() => rl.close())
  return { promise, abandon: () => rl.close() }
}

// Why: runs detached from the poll loop (see promptForPastedCode) so a login
// that completes on its own is never delayed by an unanswered prompt; any
// submit failure is swallowed here (never thrown) since nothing awaits this.
async function submitPastedCodeInBackground(
  client: RuntimeClient,
  loginId: string,
  prompt: PendingPastePrompt,
  json: boolean
): Promise<void> {
  const pastedCode = await prompt.promise
  if (!pastedCode) {
    return
  }
  try {
    await client.call('accounts.submitLoginInput', { loginId, input: pastedCode })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === LOGIN_ALREADY_SETTLED_MESSAGE) {
      // Why: this is now the expected/common outcome (the login usually
      // finishes on its own before the user finishes typing), not a real
      // error worth alarming the user about.
      const note = 'Note: the login had already completed before the pasted code was submitted.'
      if (json) {
        process.stderr.write(`${note}\n`)
      } else {
        console.log(note)
      }
      return
    }
    // Why: a genuine submit failure (network error, unexpected RPC failure)
    // must still be visibly reported, just not with the same wording used
    // for the expected already-settled case above.
    process.stderr.write(`Failed to submit the pasted code: ${message}\n`)
  }
}

type PollAccountAddResult = {
  response: RuntimeRpcSuccess<RuntimeAccountPollAddResult>
  /** True once the login URL was already printed live during polling, so the
   *  final human-readable summary can skip repeating it. */
  announcedLoginUrl: boolean
}

async function pollAccountAdd(
  client: RuntimeClient,
  provider: RuntimeAccountProvider,
  loginId: string,
  json: boolean
): Promise<PollAccountAddResult> {
  const deadline = Date.now() + ADD_ACCOUNT_TIMEOUT_MS[provider]
  let previousOutputTail = ''
  let announcedLoginUrl = false
  let announcedDeviceCode = false
  let promptedForCode = false
  // Why: kicked off but never awaited by the loop body — see
  // promptForPastedCode's comment for why blocking here would delay noticing
  // a login that finishes on its own while the prompt is still unanswered.
  let pendingPrompt: PendingPastePrompt | null = null

  // Why: pendingPrompt's readline.Interface must be released on EVERY exit
  // from this loop — normal completion, the timeout throw, and an RPC-failure
  // throw from client.call alike — or an abandoned prompt keeps the CLI
  // process alive waiting on stdin nobody needs anymore after the command has
  // already failed and returned.
  try {
    for (;;) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        throw new RuntimeClientError(
          'timeout',
          `Timed out waiting for the ${provider} login to finish. Run \`orca account add --agent ${provider}\` again.`
        )
      }
      const pollTimeoutMs = Math.min(POLL_WINDOW_MS, remainingMs)
      const response = await client.call<RuntimeAccountPollAddResult>(
        'accounts.pollAdd',
        { loginId, timeoutMs: pollTimeoutMs },
        { timeoutMs: pollTimeoutMs + POLL_CLIENT_GRACE_MS }
      )
      const { outputTail, status } = response.result

      if (!json) {
        const newText = computeNewOutputText(previousOutputTail, outputTail)
        if (newText) {
          process.stdout.write(newText)
        }
        previousOutputTail = outputTail
      }

      // Why: Codex's device code expires in ~15 minutes and --json mode
      // otherwise prints nothing until the final response, so the user would
      // never see the code in time to enter it. Announce as soon as detected
      // regardless of --json, routing to stderr under --json so stdout stays
      // clean JSON for scripts/tools parsing it.
      if (!announcedLoginUrl) {
        const loginUrl = extractLoginUrl(outputTail)
        if (loginUrl) {
          announcedLoginUrl = true
          const message = `\nLogin URL (open on another device if needed): ${loginUrl}`
          if (json) {
            process.stderr.write(`${message}\n`)
          } else {
            console.log(message)
          }
        }
      }
      if (!announcedDeviceCode) {
        const deviceCode = extractDeviceCode(outputTail)
        if (deviceCode) {
          announcedDeviceCode = true
          const message = `One-time code (enter at the URL above, expires in ~15 min): ${deviceCode}`
          if (json) {
            process.stderr.write(`${message}\n`)
          } else {
            console.log(message)
          }
        }
      }

      // Why: Claude's login has no local browser to auto-complete OAuth, so the
      // user may need to paste the code themselves; Codex's device-auth flow
      // needs no paste-back at all, so this must never fire for it. The prompt
      // itself and its eventual submit run detached from this loop (see
      // promptForPastedCode / submitPastedCodeInBackground) — the common case
      // is that Claude's CLI completes the login on its own within seconds of
      // the user authorizing in the browser, so the loop must keep polling
      // rather than block on an answer that may never matter.
      if (provider === 'claude' && !promptedForCode && PASTE_CODE_PROMPT_PATTERN.test(outputTail)) {
        // Why: set this before the prompt settles so a slow user typing the
        // answer doesn't cause a re-prompt on the next loop iteration.
        promptedForCode = true
        pendingPrompt = promptForPastedCode(json)
        // Why: intentionally not awaited — a detached background task, not a
        // step in this loop's control flow. It can never throw (see
        // submitPastedCodeInBackground), so there is nothing to catch here.
        void submitPastedCodeInBackground(client, loginId, pendingPrompt, json)
      }

      if (status !== 'in_progress') {
        return { response, announcedLoginUrl }
      }
    }
  } finally {
    // Why: release stdin if a prompt is still awaiting an answer nobody needs
    // anymore, so an abandoned readline.Interface never keeps the CLI process
    // alive after the login has already settled or the command has failed.
    pendingPrompt?.abandon()
  }
}

/**
 * Server-side login for `orca account add --environment/--pairing-code`: the
 * runtime host (not this CLI's machine) runs the actual login, since main's
 * local import RPCs take a filesystem path that only resolves on this host.
 */
export async function addAccountRemote(
  client: RuntimeClient,
  agent: RuntimeAccountProvider,
  json: boolean
): Promise<void> {
  const started = await client.call<RuntimeAccountAddStarted>(
    agent === 'codex' ? 'accounts.addCodex' : 'accounts.addClaude',
    {}
  )
  if (!json) {
    console.log(formatAccountAddStarted(agent, started.result.loginId))
  }

  const { response: finalResponse, announcedLoginUrl } = await pollAccountAdd(
    client,
    agent,
    started.result.loginId,
    json
  )
  const loginUrl = extractLoginUrl(finalResponse.result.outputTail)
  const augmentedResponse: RuntimeRpcSuccess<RuntimeAccountPollAddResult> = {
    ...finalResponse,
    result: { ...finalResponse.result, ...(loginUrl ? { loginUrl } : {}) }
  }
  // Why: JSON output always carries loginUrl; only the human-readable summary
  // omits it when the live poll already announced it, to avoid printing it twice.
  printResult(augmentedResponse, json, (result) =>
    formatAccountAddResult(result, { omitLoginUrl: announcedLoginUrl })
  )
  if (finalResponse.result.status === 'failed') {
    process.exitCode = 1
  }
}
