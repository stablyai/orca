import { vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'

export function configureWorkerReleasePaneResolution(runtime: OrcaRuntimeService): void {
  vi.spyOn(runtime, 'resolveTerminalPane').mockReturnValue({
    handle: 'term_worker',
    tabId: 'tab_worker',
    leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ptyId: 'pty_worker'
  })
}
