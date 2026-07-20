import { homedir } from 'node:os'
import { join } from 'node:path'

// Why: 네이티브 호스트(1b)는 Electron 밖에서도 실행되므로, app.getPath 대신
// 플랫폼별 userData 규칙을 직접 계산해 CLI/앱이 같은 경로를 쓰게 한다.
function orcaUserDataPath(): string {
  if (process.env.ORCA_USER_DATA_PATH) {
    return process.env.ORCA_USER_DATA_PATH
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'orca')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'orca')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'orca')
}

export function chatImportDbPath(overrideUserDataPath?: string): string {
  return join(overrideUserDataPath ?? orcaUserDataPath(), 'chat-import', 'chats.db')
}
