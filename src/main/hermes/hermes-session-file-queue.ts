// Every write, withdrawal and cleanup of one Hermes session file runs in this process, one at a
// time, so none of them takes the file from another.
const turns = new Map<string, Promise<void>>()

export function inSessionFileTurn(file: string, run: () => Promise<void>): Promise<void> {
  const next = (turns.get(file) ?? Promise.resolve()).then(run)
  const settled = next.catch(() => undefined)
  turns.set(file, settled)
  void settled.then(() => {
    if (turns.get(file) === settled) {
      turns.delete(file)
    }
  })
  return next
}
