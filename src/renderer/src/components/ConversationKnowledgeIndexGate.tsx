import { useCallback, useEffect } from 'react'
import { useAppStore } from '@/store'
import { getIntlLocale } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { getCommitMessageAgentSpec } from '../../../shared/commit-message-agent-spec'
import { CONVERSATION_KNOWLEDGE_FORMAT_VERSION } from '../../../shared/conversation-knowledge-items'

const AUTO_INDEX_INTERVAL_MS = 24 * 60 * 60 * 1_000
const AUTO_INDEX_STORAGE_KEY = 'orca:conversation-knowledge:last-auto-index-at'
const AUTO_INDEX_FORMAT_STORAGE_KEY = 'orca:conversation-knowledge:last-auto-index-format'
const AUTO_INDEX_LANGUAGE_STORAGE_KEY = 'orca:conversation-knowledge:last-auto-index-language'

export function shouldRunConversationKnowledgeAutoIndex(
  lastRunAt: number | null,
  now = Date.now(),
  lastFormatVersion = CONVERSATION_KNOWLEDGE_FORMAT_VERSION,
  lastLanguage: string | null = 'en',
  language = 'en'
): boolean {
  return (
    lastFormatVersion !== CONVERSATION_KNOWLEDGE_FORMAT_VERSION ||
    lastLanguage !== language ||
    lastRunAt === null ||
    now - lastRunAt >= AUTO_INDEX_INTERVAL_MS
  )
}

export function ConversationKnowledgeIndexGate(): null {
  useUiLanguageRevision()
  const settings = useAppStore((state) => state.settings)
  const enabled =
    settings?.conversationKnowledgeEnabled === true &&
    settings.conversationKnowledgeEnrichmentEnabled === true
  const generatorAgent = settings?.conversationKnowledgeEnrichmentAgent ?? null
  const generatorModel =
    settings?.conversationKnowledgeEnrichmentModel ??
    (generatorAgent ? getCommitMessageAgentSpec(generatorAgent)?.defaultModelId : null)
  const language = getIntlLocale()

  const reconcile = useCallback(() => {
    if (!enabled || !generatorAgent || !generatorModel) {
      return
    }
    const lastRunAt = Number.parseInt(localStorage.getItem(AUTO_INDEX_STORAGE_KEY) ?? '', 10)
    const lastFormatVersion = Number.parseInt(
      localStorage.getItem(AUTO_INDEX_FORMAT_STORAGE_KEY) ?? '',
      10
    )
    const lastLanguage = localStorage.getItem(AUTO_INDEX_LANGUAGE_STORAGE_KEY)
    if (
      !shouldRunConversationKnowledgeAutoIndex(
        Number.isFinite(lastRunAt) ? lastRunAt : null,
        Date.now(),
        Number.isFinite(lastFormatVersion) ? lastFormatVersion : 0,
        lastLanguage,
        language
      )
    ) {
      return
    }
    const startedAt = Date.now()
    localStorage.setItem(AUTO_INDEX_STORAGE_KEY, String(startedAt))
    localStorage.setItem(
      AUTO_INDEX_FORMAT_STORAGE_KEY,
      String(CONVERSATION_KNOWLEDGE_FORMAT_VERSION)
    )
    localStorage.setItem(AUTO_INDEX_LANGUAGE_STORAGE_KEY, language)
    void window.api.aiVault
      .startKnowledgeIndex({
        generatorAgent,
        generatorModel,
        language
      })
      .catch((error) => {
        if (localStorage.getItem(AUTO_INDEX_STORAGE_KEY) === String(startedAt)) {
          localStorage.removeItem(AUTO_INDEX_STORAGE_KEY)
          localStorage.removeItem(AUTO_INDEX_FORMAT_STORAGE_KEY)
          localStorage.removeItem(AUTO_INDEX_LANGUAGE_STORAGE_KEY)
        }
        console.error('[conversation-knowledge] Indexing failed:', error)
      })
  }, [enabled, generatorAgent, generatorModel, language])

  useEffect(() => {
    reconcile()
    return window.api.aiVault.onWindowFocused(reconcile)
  }, [reconcile])

  return null
}
