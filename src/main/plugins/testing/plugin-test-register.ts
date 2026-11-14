/** `node --import orca-test-register.mjs`: installs the plugin test hooks shipped beside it. */
import { register } from 'node:module'

register('./orca-test-hooks.mjs', import.meta.url)
