// Entry point of orca-sandbox-build-runner-* (wrangler.build-runner.dev.jsonc). The runner lives in its
// own Worker because Cloudflare generates no preview URLs for a Worker that implements a Durable Object:
// hosting it in the control plane made every `wrangler versions upload --preview-alias` URL 404.
// The runner only keeps the alarm; each step runs in the control plane (BuildTicker in index.ts) over
// an RPC service binding, so the build code, D1 and every secret stay in one Worker.

/** The control plane's BuildTicker entrypoint, as the runner sees it. */
export type BuildTickerApi = {
  /** Advances the build one step; the delay (ms) until the next step, or null once it is final. */
  tickBuild(build: RunnerBuild): Promise<number | null>
}

export type RunnerBuild = { id: string; environmentId: string }

export type BuildRunnerEnv = {
  CONTROL: BuildTickerApi
}

/** Retry delay after a step fails (control plane unreachable, provider error). */
export const RUNNER_RETRY_MS = 15_000

/**
 * One per environment build: wakes on an alarm, has the control plane advance the build one step
 * (finalize, snapshot, smoke boot, billing all run there) and re-arms until the build is final. Builds
 * therefore finish with no client watching, at most a few seconds after their VM command ends. The
 * control plane's cron re-arms every unfinished build each minute, so a lost runner costs a minute.
 */
export class EnvironmentBuildRunner implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: BuildRunnerEnv
  ) {}

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as Partial<RunnerBuild> | null
    if (!body?.id || !body.environmentId) {
      return new Response('bad request', { status: 400 })
    }
    await this.state.storage.put('build', { id: body.id, environmentId: body.environmentId })
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + 2_000)
    }
    return new Response(null, { status: 204 })
  }

  async alarm(): Promise<void> {
    const build = await this.state.storage.get<RunnerBuild>('build')
    if (!build) {
      await this.state.storage.deleteAll()
      return
    }
    let next: number | null
    try {
      next = await this.env.CONTROL.tickBuild({ id: build.id, environmentId: build.environmentId })
    } catch (error) {
      console.log(JSON.stringify({ event: 'environment_build_tick_failed', buildId: build.id, error: String(error).slice(0, 200) }))
      next = RUNNER_RETRY_MS
    }
    if (next === null) {
      await this.state.storage.deleteAll()
      return
    }
    await this.state.storage.setAlarm(Date.now() + next)
  }
}

export default {
  // No public surface: the control plane reaches the runner through its Durable Object binding only.
  fetch(): Response {
    return new Response('not found', { status: 404 })
  }
} satisfies ExportedHandler<BuildRunnerEnv>
