import type { AgentSessionOptionChoice } from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionModelOption } from '../../../shared/agent-session/options/model-catalog/agent-session-model-option'

/** Transient hydration pool that shares identical immutable catalog rows across fingerprints. */
export class AgentModelCatalogInternPool {
  private readonly choices = new Map<string, { id: number; value: AgentSessionOptionChoice }>()
  private readonly choiceLists = new Map<string, AgentSessionOptionChoice[]>()
  private readonly models = new Map<string, { id: number; value: AgentSessionModelOption }>()
  private readonly modelLists = new Map<string, AgentSessionModelOption[]>()
  private nextChoiceId = 0
  private nextModelId = 0

  internChoice(choice: AgentSessionOptionChoice): AgentSessionOptionChoice {
    return this.internChoiceRecord(choice).value
  }

  internChoiceList(choices: readonly AgentSessionOptionChoice[]): AgentSessionOptionChoice[] {
    const ids: number[] = []
    const canonical: AgentSessionOptionChoice[] = []
    for (const choice of choices) {
      const record = this.internChoiceRecord(choice)
      ids.push(record.id)
      canonical.push(record.value)
    }
    const key = ids.join(',')
    const existing = this.choiceLists.get(key)
    if (existing) {
      return existing
    }
    this.choiceLists.set(key, canonical)
    return canonical
  }

  internModelList(models: readonly AgentSessionModelOption[]): AgentSessionModelOption[] {
    const ids: number[] = []
    const canonical: AgentSessionModelOption[] = []
    for (const model of models) {
      const record = this.internModelRecord(model)
      ids.push(record.id)
      canonical.push(record.value)
    }
    const key = ids.join(',')
    const existing = this.modelLists.get(key)
    if (existing) {
      return existing
    }
    this.modelLists.set(key, canonical)
    return canonical
  }

  private internChoiceRecord(choice: AgentSessionOptionChoice): {
    id: number
    value: AgentSessionOptionChoice
  } {
    const key = `${choice.value}\u0000${choice.label}\u0000${choice.description ?? ''}`
    const existing = this.choices.get(key)
    if (existing) {
      return existing
    }
    const record = { id: this.nextChoiceId++, value: choice }
    this.choices.set(key, record)
    return record
  }

  private internModelRecord(model: AgentSessionModelOption): {
    id: number
    value: AgentSessionModelOption
  } {
    const key = JSON.stringify(model)
    const existing = this.models.get(key)
    if (existing) {
      return existing
    }
    const normalized: AgentSessionModelOption = {
      ...model,
      efforts: this.internChoiceList(model.efforts),
      ...(model.serviceTiers ? { serviceTiers: this.internChoiceList(model.serviceTiers) } : {}),
      ...(model.chatEfforts ? { chatEfforts: this.internChoiceList(model.chatEfforts) } : {})
    }
    const record = { id: this.nextModelId++, value: normalized }
    this.models.set(key, record)
    return record
  }
}
