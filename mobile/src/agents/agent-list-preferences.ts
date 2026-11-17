import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  AGENT_LIST_GROUP_BY_CHOICES,
  DEFAULT_AGENT_LIST_VIEW,
  type AgentListView
} from './agent-list-model'

const AGENT_LIST_VIEW_KEY = 'orca:agentListView'

export async function loadAgentListView(): Promise<AgentListView> {
  try {
    const raw = await AsyncStorage.getItem(AGENT_LIST_VIEW_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') {
      return DEFAULT_AGENT_LIST_VIEW
    }
    const groupBy = 'groupBy' in parsed ? parsed.groupBy : undefined
    const showWorkers = 'showWorkers' in parsed ? parsed.showWorkers : undefined
    const unreadOnly = 'unreadOnly' in parsed ? parsed.unreadOnly : undefined
    return {
      groupBy:
        AGENT_LIST_GROUP_BY_CHOICES.find((choice) => choice === groupBy) ??
        DEFAULT_AGENT_LIST_VIEW.groupBy,
      showWorkers:
        typeof showWorkers === 'boolean' ? showWorkers : DEFAULT_AGENT_LIST_VIEW.showWorkers,
      unreadOnly: typeof unreadOnly === 'boolean' ? unreadOnly : DEFAULT_AGENT_LIST_VIEW.unreadOnly
    }
  } catch {
    return DEFAULT_AGENT_LIST_VIEW
  }
}

export async function saveAgentListView(view: AgentListView): Promise<void> {
  await AsyncStorage.setItem(AGENT_LIST_VIEW_KEY, JSON.stringify(view))
}
