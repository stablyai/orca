type CountsProvider = () => { inflight: number; queued: number }
let provider: CountsProvider = () => ({ inflight: 0, queued: 0 })

export function setGitAdmissionCountsProvider(next: CountsProvider): void {
  provider = next
}

export function gitAdmissionCountsSnapshot(): { inflight: number; queued: number } {
  return provider()
}
