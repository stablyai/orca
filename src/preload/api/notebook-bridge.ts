import { ipcRenderer } from 'electron'

export const notebookApi = {
  runPythonCell: (args: {
    filePath: string
    code: string
    preamble?: string
    connectionId?: string | null
  }): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> =>
    ipcRenderer.invoke('notebook:runPythonCell', args)
}
