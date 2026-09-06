import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const feedbackApi = {
  submit: (args: {
    feedback: string
    submitAnonymously?: boolean
    githubLogin: string | null
    githubEmail: string | null
    images?: { contentType: string; data: Uint8Array }[]
  }): Promise<
    { ok: true; imagesDelivered?: boolean } | { ok: false; status: number | null; error: string }
  > => ipcRenderer.invoke('feedback:submit', args)
} satisfies PreloadApi['feedback']
