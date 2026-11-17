export class ClaudeProfileSetupQueue<T> {
  private readonly jobs = new Map<string, { privateHistory: boolean; task: Promise<T> }>()

  pending(id: string): Promise<T> | undefined {
    return this.jobs.get(id)?.task
  }

  run(id: string, privateHistory: boolean, start: () => Promise<T>): Promise<T> {
    const current = this.jobs.get(id)
    if (current?.privateHistory === privateHistory) {
      return current.task
    }
    const task = (current ? current.task.catch(() => {}) : Promise.resolve())
      .then(start)
      .finally(() => {
        if (this.jobs.get(id)?.task === task) {
          this.jobs.delete(id)
        }
      })
    this.jobs.set(id, { privateHistory, task })
    return task
  }
}
