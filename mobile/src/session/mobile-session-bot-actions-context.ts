import { createContext } from 'react'
import type { ActionSheetAction } from '../components/sheets/ActionSheetModal'

/** The route bot's entry that leads the header's more-actions menu; none off a bot's home. */
export const MobileSessionBotActionsContext = createContext<readonly ActionSheetAction[]>([])
