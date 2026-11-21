import type { SessionConfigOption } from '../generated/acp-protocol.generated'
import { findAcpPermissionModeSelect } from '../launch/acp-launch-permission-modes'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

/** The permission select Orca has seen, and the value an empty menu confirmed. */
export class AcpPermissionModeState {
  private confirmedValue: string | null = null
  private selectId: string | null = null

  constructor(private readonly configId?: string) {}

  reset(options: readonly SessionConfigOption[]): void {
    this.confirmedValue = null
    this.selectId = this.select(options)?.id ?? null
  }

  noteOptions(options: readonly SessionConfigOption[]): void {
    const select = this.select(options)
    if (select) {
      this.selectId = select.id
      this.confirmedValue = null
    }
  }

  confirm(value: string | null): void {
    this.confirmedValue = value
  }

  hasSelect(options: readonly SessionConfigOption[], configId?: string): boolean {
    return this.selectId !== null || this.select(options, configId) !== null
  }

  reported(
    applied: string | undefined,
    options: readonly SessionConfigOption[],
    values: Readonly<Partial<Record<string, string>>> | undefined,
    configId?: string
  ): string | null {
    if (!values) {
      return applied ?? null
    }
    const cur = this.select(options, configId)?.currentValue ?? this.confirmedValue
    return cur ? (Object.entries(values).find(([, value]) => value === cur)?.[0] ?? null) : null
  }

  configIdFor(options: readonly SessionConfigOption[], fallback?: string): string {
    return this.select(options, fallback)?.id ?? this.selectId ?? fallback ?? 'mode'
  }

  /** Apply a mode the agent reported, and drop a confirmed value it no longer matches. */
  withCurrentMode(options: readonly SessionConfigOption[], modeId: string): SessionConfigOption[] {
    const select = this.select(options)
    if (select) {
      this.selectId = select.id
    }
    if (this.confirmedValue !== null && this.confirmedValue !== modeId) {
      this.confirmedValue = null
    }
    return select
      ? options.map((option) =>
          this.isPermissionSelect(option, select) ? { ...option, currentValue: modeId } : option
        )
      : [...options]
  }

  /** An unconfirmed empty menu proves nothing; keep every select except permission. */
  withoutSelect(options: readonly SessionConfigOption[]): SessionConfigOption[] {
    this.confirmedValue = null
    let next = [...options]
    let select = this.select(next)
    while (select) {
      const target = select
      next = next.filter((option) => !this.isPermissionSelect(option, target))
      select = this.select(next)
    }
    return next
  }

  private select(
    options: readonly SessionConfigOption[],
    configId = this.configId
  ): SelectOption | null {
    return findAcpPermissionModeSelect(options, configId)
  }

  private isPermissionSelect(
    option: SessionConfigOption,
    select: SelectOption
  ): option is SelectOption {
    return option.type === 'select' && option.id === select.id
  }
}
