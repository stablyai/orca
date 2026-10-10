export function quoteHiddenRateLimitShellValue(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
