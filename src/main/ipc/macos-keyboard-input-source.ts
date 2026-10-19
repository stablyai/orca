import { spawn } from 'node:child_process'

const KEYBOARD_INPUT_SOURCE_TIMEOUT_MS = 500
const MAC_HITOOLBOX_DOMAIN = 'com.apple.HIToolbox'
// Why: defaults export reads live prefs (on-disk plist lags cfprefsd); xml1 dodges plutil's json abort on macOS 15 input-source arrays; absolute paths so a minimal PATH can't shadow the tools.
const MAC_SELECTED_INPUT_SOURCES_JSON_COMMAND = [
  `/usr/bin/defaults export ${MAC_HITOOLBOX_DOMAIN} -`,
  '/usr/bin/plutil -extract AppleSelectedInputSources xml1 -o - -',
  '/usr/bin/plutil -convert json -o - -'
].join(' | ')

export function readCommandStdout(
  command: string,
  args: string[],
  timeoutMessage: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let child: ReturnType<typeof spawn> | undefined

    // Why: killing only the shell orphans pipeline stages; detached spawn lets one negative-pid SIGKILL reap the whole group.
    const killTree = (): void => {
      if (!child?.pid) {
        return
      }
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill()
      }
    }

    // Why: short timeout so a wedged macOS probe never hangs; this timer owns the process-group kill.
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      killTree()
      reject(new Error(timeoutMessage))
    }, KEYBOARD_INPUT_SOURCE_TIMEOUT_MS)

    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      callback()
    }

    try {
      child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
      let stdout = ''
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      const failWith = (error: Error): void => {
        killTree()
        settle(() => reject(error))
      }
      // Why: an unhandled Readable 'error' would crash the main process; treat stdout errors like spawn errors.
      child.stdout?.on('error', failWith)
      child.on('error', failWith)
      child.on('close', (code, signal) => {
        settle(() =>
          code === 0
            ? resolve(stdout)
            : reject(
                new Error(
                  `${command} exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`
                )
              )
        )
      })
    } catch (error) {
      settle(() => reject(error))
    }
  })
}

type SelectedKeyboardInputSource = { kind: 'inputSource'; id: string } | { kind: 'keyboardLayout' }

function readSelectedInputSourceFromJson(stdout: string): SelectedKeyboardInputSource | null {
  let records: unknown
  try {
    records = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(records)) {
    return null
  }

  let hasSelectedKeyboardLayout = false
  for (const record of records.slice().toReversed()) {
    if (!record || typeof record !== 'object') {
      continue
    }
    const kind =
      'InputSourceKind' in record && typeof record.InputSourceKind === 'string'
        ? record.InputSourceKind.trim().toLowerCase()
        : ''
    if (kind === 'keyboard layout') {
      hasSelectedKeyboardLayout = true
      continue
    }
    if (kind.includes('non keyboard')) {
      continue
    }
    if (kind !== 'input mode' && kind !== 'keyboard input method') {
      return null
    }
    const inputMode = 'Input Mode' in record ? record['Input Mode'] : undefined
    const bundleId = 'Bundle ID' in record ? record['Bundle ID'] : undefined
    const id = typeof inputMode === 'string' && inputMode.trim() ? inputMode : bundleId
    if (typeof id === 'string' && id.trim()) {
      return { kind: 'inputSource', id: id.trim() }
    }
    return null
  }
  return hasSelectedKeyboardLayout ? { kind: 'keyboardLayout' } : null
}

async function readSelectedKeyboardInputSource(): Promise<SelectedKeyboardInputSource | null> {
  try {
    const stdout = await readCommandStdout(
      '/bin/sh',
      ['-c', MAC_SELECTED_INPUT_SOURCES_JSON_COMMAND],
      'Selected keyboard input source probe timed out'
    )
    return readSelectedInputSourceFromJson(stdout)
  } catch {
    return null
  }
}

export async function readKeyboardInputSourceId(): Promise<string | null> {
  const selectedInputSource = await readSelectedKeyboardInputSource()
  if (selectedInputSource?.kind === 'inputSource') {
    return selectedInputSource.id
  }
  // An IME can use ABC underneath; the backing layout alone cannot identify the selected source.
  return selectedInputSource?.kind === 'keyboardLayout'
    ? readCommandStdout(
        '/usr/bin/defaults',
        ['read', MAC_HITOOLBOX_DOMAIN, 'AppleCurrentKeyboardLayoutInputSourceID'],
        'Keyboard layout input source probe timed out'
      )
    : null
}
