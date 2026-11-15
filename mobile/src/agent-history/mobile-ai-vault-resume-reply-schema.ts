import * as z from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Older hosts may return no repin data; retain exact boolean/string guards and handle unsupported-method refusal before parsing.
export const aiVaultResumePreparationSchema = z
  .looseObject({
    useRealCodexHome: salvagedOptional('useRealCodexHome', z.boolean()),
    substituteCodexHome: salvagedOptional('substituteCodexHome', z.string())
  })
  .nullish()
