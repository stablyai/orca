import { ipcMain } from 'electron'
import {
  capturedDigitChordsFromSymbolicHotkeysJson,
  type MacCapturedDigitChord
} from '../../shared/macos-symbolic-hotkeys'

// Why: symbolichotkeys is plain dict/int/bool, so unlike HIToolbox a whole-domain json convert is safe.
const MAC_SYMBOLIC_HOTKEYS_JSON_COMMAND = [
  '/usr/bin/defaults export com.apple.symbolichotkeys -',
  '/usr/bin/plutil -convert json -o - -'
].join(' | ')

type ReadCommandStdout = (
  command: string,
  args: string[],
  timeoutMessage: string
) => Promise<string>

// Why: Mission Control's Spaces chords (Ctrl+digit by default) are consumed by WindowServer
// before app delivery, so the renderer can only detect the conflict, never observe the press.
export function registerMacSymbolicHotkeysProbeHandler(readCommandStdout: ReadCommandStdout): void {
  ipcMain.handle('app:getMacCapturedDigitChords', async (): Promise<MacCapturedDigitChord[]> => {
    if (process.platform !== 'darwin') {
      return []
    }
    try {
      const stdout = await readCommandStdout(
        '/bin/sh',
        ['-c', MAC_SYMBOLIC_HOTKEYS_JSON_COMMAND],
        'Symbolic hotkeys probe timed out'
      )
      return capturedDigitChordsFromSymbolicHotkeysJson(JSON.parse(stdout))
    } catch {
      // Why: no signal (missing domain, sandbox, timeout) must never surface a false warning.
      return []
    }
  })
}
