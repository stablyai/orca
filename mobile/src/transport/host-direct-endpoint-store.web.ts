import type { HostProfile } from './types'

/** Direct-endpoint refresh is native; the page does not dial or persist host rows. */
export const saveRefreshedDirectEndpoint = (_host: HostProfile): Promise<void> => Promise.resolve()
