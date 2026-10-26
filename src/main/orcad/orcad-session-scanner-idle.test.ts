import { describe, expect, it } from 'vitest'
import {
  orcadSessionScannerIdleTimeoutMs,
  WSL_HOST_SESSION_SCANNER_IDLE_TIMEOUT_MS
} from './orcad-session-scanner-idle'

describe('orcadSessionScannerIdleTimeoutMs', () => {
  it('shortens the scanner idle timeout to three minutes on a WSL host', () => {
    expect(orcadSessionScannerIdleTimeoutMs(() => true)).toBe(
      WSL_HOST_SESSION_SCANNER_IDLE_TIMEOUT_MS
    )
    expect(WSL_HOST_SESSION_SCANNER_IDLE_TIMEOUT_MS).toBe(180_000)
  })

  it('leaves an SSH host on the scanner’s own default', () => {
    expect(orcadSessionScannerIdleTimeoutMs(() => false)).toBeNull()
  })
})
