import type { TransientPtyCommand } from './daemon-transient-pty'
export type TransientPtyRequest =
  | {
      id: string
      type: 'createTransientPty'
      payload: TransientPtyCommand
    }
  | { id: string; type: 'writeTransientPty'; payload: { id: string; data: string } }
  | { id: string; type: 'closeTransientPty'; payload: { id: string } }
