export type ChildTerminationReporter = {
  report: () => void
  reportIf: (confirmed: boolean) => void
}

export function createChildTerminationReporter(callback?: () => void): ChildTerminationReporter {
  let reported = false
  const report = (): void => {
    if (reported) {
      return
    }
    reported = true
    callback?.()
  }
  return { report, reportIf: (confirmed) => (confirmed ? report() : undefined) }
}
