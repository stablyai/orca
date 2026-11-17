// TEMPORARY CI diagnostic: records account-move events only while a test installs a sink.
let sink: string[] | null = null

export function setAccountMoveTraceSink(next: string[] | null): void {
  sink = next
}

export function traceAccountMove(...parts: unknown[]): void {
  sink?.push(
    parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')
  )
}
