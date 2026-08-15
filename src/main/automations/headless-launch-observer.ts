export type HeadlessLaunchStatus = {
  agentType?: string
  providerSessionOnly?: boolean
  receivedAt: number
}

export function waitForHeadlessAgentLaunch(params: {
  paneKey: string | null
  agentType: string
  launchedAt: number
  deadlineAt: number
  getStatusSnapshotForPane: (paneKey: string) => HeadlessLaunchStatus[]
}): Promise<void> {
  if (!params.paneKey) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setInterval> | null = null
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const check = (): void => {
      try {
        const launched = params
          .getStatusSnapshotForPane(params.paneKey!)
          .some(
            (status) =>
              status.agentType === params.agentType &&
              status.providerSessionOnly !== true &&
              status.receivedAt >= params.launchedAt
          )
        if (launched) {
          finish()
          return
        }
        if (Date.now() >= params.deadlineAt) {
          finish(new Error(`Headless ${params.agentType} agent did not report a launch status.`))
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }

    check()
    if (!settled) {
      timer = setInterval(check, 250)
    }
  })
}
