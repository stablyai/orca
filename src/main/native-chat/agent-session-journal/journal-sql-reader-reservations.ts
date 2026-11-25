import type { JournalForkPreparationResult } from './journal-fork-preparation'
import type { JournalDomainImportHeader, JournalDomainImportPage } from './journal-domain-import'
import type { ReaderSlot } from './journal-sql-reader-slot'

export class JournalSqlForkReader {
  private closing?: Promise<void>
  constructor(
    private readonly slot: ReaderSlot,
    private readonly preparationId: number,
    private readonly release: () => void,
    private readonly chat: string | null
  ) {}
  async next(): Promise<JournalForkPreparationResult> {
    const response = await this.slot.request(
      { kind: 'fork-next', preparationId: this.preparationId },
      { chat: this.chat }
    )
    if (response.type !== 'fork-next') {
      throw new Error('fork reader returned no preparation step')
    }
    return response.result
  }
  close(): Promise<void> {
    return (this.closing ??= this.slot
      .request({ kind: 'fork-release', preparationId: this.preparationId }, { chat: this.chat })
      .then(() => {})
      .finally(this.release))
  }
}

/** The reservation keeps pages on the worker holding this chat's restored rows. */
export class JournalSqlConversionReader {
  private closing?: Promise<void>

  constructor(
    readonly header: JournalDomainImportHeader,
    private readonly slot: ReaderSlot,
    private readonly conversionId: number,
    private readonly release: () => void,
    private readonly chat: string | null
  ) {}

  async next(): Promise<JournalDomainImportPage | null> {
    const response = await this.slot.request(
      { kind: 'conversion-page', conversionId: this.conversionId },
      { chat: this.chat }
    )
    if (response.type !== 'rows') {
      throw new Error('journal reader returned no conversion page')
    }
    return response.page
  }

  close(): Promise<void> {
    return (this.closing ??= this.slot
      .request({ kind: 'conversion-release', conversionId: this.conversionId }, { chat: this.chat })
      .then(() => {})
      .finally(this.release))
  }
}
