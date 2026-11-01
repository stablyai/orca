import type { RefObject } from 'react'

// Native screen readers already skip a covered view through aria-hidden, and phones have no Tab order to leave.
export function useCoveredInert(_ref: RefObject<unknown>, _covered: boolean): void {}
