import type { CommandSpec } from '../args'
import { BROWSER_ADVANCED_COMMAND_SPECS } from './browser-advanced'
import { BROWSER_BASIC_COMMAND_SPECS } from './browser-basic'
import { CORE_COMMAND_SPECS } from './core'
import { ORCHESTRATION_COMMAND_SPECS } from './orchestration'
import { COMPUTER_COMMAND_SPECS } from './computer'
import { NOTE_COMMAND_SPECS } from './note'

export const COMMAND_SPECS: CommandSpec[] = [
  ...CORE_COMMAND_SPECS,
  ...BROWSER_BASIC_COMMAND_SPECS,
  ...BROWSER_ADVANCED_COMMAND_SPECS,
  ...ORCHESTRATION_COMMAND_SPECS,
  ...COMPUTER_COMMAND_SPECS,
  ...NOTE_COMMAND_SPECS
]
