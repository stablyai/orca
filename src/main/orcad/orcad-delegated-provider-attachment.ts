import type { IPtyProvider, PtyProviderBufferSnapshot } from '../providers/pty-provider-contract'
import type { OrcadDelegatedProviderInput } from './orcad-delegated-provider-input'
import type { createOrcadDelegatedPtyOperations } from './orcad-delegated-pty-operations'

/** Attachment observes the incumbent and restored model; it never spawns or replays bytes. */
export class OrcadDelegatedProviderAttachment {
  constructor(
    private readonly options: {
      ptyId: string
      input: Pick<OrcadDelegatedProviderInput, 'runControl'>
      operations: Pick<ReturnType<typeof createOrcadDelegatedPtyOperations>, 'inspectTerminalInfo'>
      isActive: () => boolean
      getModelSequence: () => number
      getSnapshot: (options?: {
        scrollbackRows?: number
      }) => Promise<PtyProviderBufferSnapshot | null>
    }
  ) {}

  getBufferSnapshot: NonNullable<IPtyProvider['getBufferSnapshot']> = (id, options) => {
    const captured = { ...options }
    return this.options.input.runControl(id, () => this.snapshot(id, captured))
  }

  attach: IPtyProvider['attach'] = (id) =>
    this.options.input.runControl(id, async () => {
      this.assertActive(id)
      const before = await this.options.operations.inspectTerminalInfo(id)
      this.assertActive(id)
      if (!before) {
        throw new Error('orcad_delegated_attach_unverifiable')
      }
      const model = await this.snapshot(id)
      if (!model) {
        throw new Error('orcad_delegated_attach_model_unavailable')
      }
      const after = await this.options.operations.inspectTerminalInfo(id)
      this.assertActive(id)
      if (!after || after.pid !== before.pid || this.options.getModelSequence() !== model.seq) {
        throw new Error('orcad_delegated_attach_unverifiable')
      }
      return { providerSequence: { value: model.seq, generation: 'continued' } }
    })

  private async snapshot(id: string, options?: { scrollbackRows?: number }) {
    this.assertActive(id)
    const model = await this.options.getSnapshot(options)
    this.assertActive(id)
    if (
      model &&
      (model.source !== 'headless' || !Number.isSafeInteger(model.seq) || model.seq < 0)
    ) {
      throw new Error('orcad_delegated_provider_snapshot_invalid')
    }
    return model
  }

  private assertActive(id: string) {
    if (id !== this.options.ptyId || !this.options.isActive()) {
      throw new Error('orcad_delegated_attach_unverifiable')
    }
  }
}
