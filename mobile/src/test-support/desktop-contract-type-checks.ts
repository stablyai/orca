/** Keys the two types share whose desktop value the phone's type would not accept. */
export type FieldsRetypedByPhone<Desktop, Phone> = {
  [K in keyof Desktop & keyof Phone]-?: [NonNullable<Desktop[K]>] extends [NonNullable<Phone[K]>]
    ? never
    : K
}[keyof Desktop & keyof Phone]

/** Keys the phone adds that the desktop also names: the desktop's value would be read as the phone's. */
export type PhoneKeysTakenByDesktop<PhoneOnly, Desktop> = Extract<keyof PhoneOnly, keyof Desktop>
