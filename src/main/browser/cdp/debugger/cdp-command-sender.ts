export type CdpCommandSender = (
  method: string,
  params?: Record<string, unknown>
) => Promise<unknown>
