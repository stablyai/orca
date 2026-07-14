import { createHash } from 'node:crypto'

// Chrome 확장 ID = SHA-256(공개키 SPKI DER)의 앞 16바이트를 hex로, 각 hex 숫자(0–f)를 a–p로 매핑.
export function deriveChromeExtensionId(publicKeyDerBase64: string): string {
  const der = Buffer.from(publicKeyDerBase64, 'base64')
  const hash = createHash('sha256').update(der).digest('hex').slice(0, 32)
  return hash.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
}

// manifest.json의 key(공개키)로부터 결정론적으로 파생된 확장 ID.
// 이 고정 ID는 언패킹 로드/자체 배포에만 유효하다. Chrome 웹 스토어에 게시하면
// 스토어가 ID를 새로 배정하므로, 이미 설치된 네이티브 호스트의 allowed_origins와
// 어긋난다 — 게시 전환 시 설치 로직을 함께 재검토해야 한다.
export const CHAT_IMPORT_EXTENSION_ID = 'biffnikigibgbfgplhppmioffigodhgj'
