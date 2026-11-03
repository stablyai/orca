/** Keys the two types share whose desktop value, null included, the phone's type would not accept. */
export type FieldsRetypedByPhone<Desktop, Phone> = {
  [K in keyof Desktop & keyof Phone]-?: [Exclude<Desktop[K], undefined>] extends [
    Exclude<Phone[K], undefined>
  ]
    ? never
    : K
}[keyof Desktop & keyof Phone]

/** Keys the phone adds that the desktop also names: the desktop's value would be read as the phone's. */
export type PhoneKeysTakenByDesktop<PhoneOnly, Desktop> = Extract<keyof PhoneOnly, keyof Desktop>
