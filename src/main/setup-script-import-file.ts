import { readNodeFileWithinLimit } from '../shared/node-bounded-file-reader'
import {
  isSetupScriptImportTextWithinLimit,
  SETUP_SCRIPT_IMPORT_FILE_MAX_BYTES,
  SETUP_SCRIPT_IMPORT_MAX_CODE_UNITS
} from '../shared/setup-script-import-limits'

export {
  isSetupScriptImportTextWithinLimit,
  SETUP_SCRIPT_IMPORT_FILE_MAX_BYTES,
  SETUP_SCRIPT_IMPORT_MAX_CODE_UNITS
}

export async function readSetupScriptImportFile(filePath: string): Promise<string> {
  return (
    await readNodeFileWithinLimit(filePath, SETUP_SCRIPT_IMPORT_FILE_MAX_BYTES)
  ).buffer.toString('utf-8')
}
