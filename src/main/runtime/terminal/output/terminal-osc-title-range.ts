export function findLastCompleteOscTitleRange(data: string): { start: number; end: number } | null {
  let last: { start: number; end: number } | null = null
  let searchFrom = 0
  while (searchFrom < data.length) {
    const start = data.indexOf('\x1b]', searchFrom)
    if (start === -1) {
      break
    }
    const command = data[start + 2]
    if ((command !== '0' && command !== '1' && command !== '2') || data[start + 3] !== ';') {
      searchFrom = start + 2
      continue
    }
    let cursor = start + 4
    for (; cursor < data.length; cursor += 1) {
      if (data[cursor] === '\x07') {
        last = { start, end: cursor + 1 }
        searchFrom = cursor + 1
        break
      }
      if (data[cursor] !== '\x1b') {
        continue
      }
      if (data[cursor + 1] === '\\') {
        last = { start, end: cursor + 2 }
        searchFrom = cursor + 2
      } else {
        searchFrom = cursor
      }
      break
    }
    if (cursor === data.length) {
      break
    }
  }
  return last
}
