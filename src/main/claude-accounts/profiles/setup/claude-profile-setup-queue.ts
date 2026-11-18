export class ClaudeProfileSetupQueue<T> {
  private readonly jobs = new Map<string, { privateHistory: boolean; task: Promise<T> }>()
  private readonly removed = new Set<string>()

  async remove(id: string, remove: () => Promise<void>): Promise<void> {
    this.removed.add(id)
    await this.pending(id)?.catch(() => {})
    try {
      await remove()
    } catch (error) {
      this.removed.delete(id)
      throw error
    }
  }

  pending(id: string): Promise<T> | undefined {
    return this.jobs.get(id)?.task
  }

  run(id: string, privateHistory: boolean, start: () => Promise<T>): Promise<T> {
    if (this.removed.has(id)) {
      return Promise.reject(new Error('This Claude account is being removed or no longer exists.'))
    }
    const current = this.jobs.get(id)
    if (current?.privateHistory === privateHistory) {
      return current.task
    }
    const task = (current ? current.task.catch(() => {}) : Promise.resolve())
      .then(() => {
        if (this.removed.has(id)) {
          throw new Error('This Claude account is being removed or no longer exists.')
        }
        return start()
      })
      .finally(() => {
        if (this.jobs.get(id)?.task === task) {
          this.jobs.delete(id)
        }
      })
    this.jobs.set(id, { privateHistory, task })
    return task
  }
}
