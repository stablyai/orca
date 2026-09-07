import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const notebookApi = {
  runPythonCell: (args: {
    filePath: string
    code: string
    preamble?: string
    connectionId?: string | null
  }): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> =>
    ipcRenderer.invoke('notebook:runPythonCell', args)
} satisfies PreloadApi['notebook']
