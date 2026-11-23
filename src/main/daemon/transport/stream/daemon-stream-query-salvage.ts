import { extractHiddenStartupRendererQueryData } from '../../../../shared/terminal/protocol/queries/terminal-reply-query-extraction'

export function salvageDroppedDaemonStreamQueries(dropped: string): string {
  if (!dropped.includes('\x1b')) {
    return ''
  }
  const extracted = extractHiddenStartupRendererQueryData(dropped, '')
  return extracted.statelessQueryData + extracted.statefulQueryData + extracted.oscColorQueryData
}
