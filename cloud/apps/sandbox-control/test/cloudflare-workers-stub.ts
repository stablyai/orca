// `cloudflare:workers` exists only in workerd; vitest (Node) aliases it here. Tests construct
// entrypoints directly with (ctx, env), as the runtime does.
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    protected readonly ctx: unknown,
    protected readonly env: Env
  ) {}
}
