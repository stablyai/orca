export type HostSessionTerminalOperations = {
  sendInput(
    terminalId: string,
    text: string,
    enter: boolean,
    clientId: string | null
  ): Promise<boolean>
  setDisplayMode(
    terminalId: string,
    mode: 'auto' | 'desktop',
    viewport: { cols: number; rows: number } | null,
    clientId: string | null
  ): Promise<boolean>
  clear(terminalId: string): Promise<boolean>
  rename(terminalId: string, title: string): Promise<boolean>
}
