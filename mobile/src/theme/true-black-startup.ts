import { readTrueBlackPreference } from './true-black-preference'
import { setTrueBlackAtStartup } from './true-black-state'

setTrueBlackAtStartup(readTrueBlackPreference())
