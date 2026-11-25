import { useSyncExternalStore } from 'react'
import { readNativeChatQuotableSelection } from '../../../../../../src/shared/native-chat/input/quotes/native-chat-quote-selection'

function subscribe(onChange: () => void): () => void {
  document.addEventListener('selectionchange', onChange)
  return () => document.removeEventListener('selectionchange', onChange)
}

const readQuote = (): string | null => readNativeChatQuotableSelection(document.body)?.text ?? null

/** The agent-reply passage the page's selection holds, as desktop's Add to chat reads it; null otherwise. */
export function useMobileNativeChatSelectionQuote(): string | null {
  return useSyncExternalStore(subscribe, readQuote)
}
