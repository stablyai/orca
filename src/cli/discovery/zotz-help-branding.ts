import { ZOTZ_PRODUCT_NAME } from '../../shared/zotz/zotz-app-identity'

// Capitalized product name only: lowercase `orca` names (env vars, `orca://`, packages) stay intact.
const ORCA_PRODUCT_WORD = /\b([Aa])n Orca\b|\bOrca\b/g

export function withZotzProductName(text: string): string {
  return text.replace(ORCA_PRODUCT_WORD, (_match, article?: string) =>
    article ? `${article} ${ZOTZ_PRODUCT_NAME}` : ZOTZ_PRODUCT_NAME
  )
}
