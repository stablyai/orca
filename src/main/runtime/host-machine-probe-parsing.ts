import type { HostMachine } from '../../shared/host-machine-line'

// Firmware placeholders vendors leave in DMI/CIM model fields.
const PLACEHOLDER_MODEL =
  /^(to be filled by o\.?e\.?m\.?|system product name|system version|system family|default string|not applicable|not specified|none|n\/a|unknown|oem|o\.e\.m\.|type1productconfigid|0+|x+)$/i
const VIRTUAL_MACHINE =
  /\b(virtual machine|virtualbox|vmware|kvm|qemu|bochs|xen|hvm domu|parallels|amazon ec2|google compute engine|openstack|droplet|digitalocean|vserver|standard pc)\b/i
// Lenovo puts its machine-type code ("20XWCTO1WW") in the product name and the real name in the family.
const MACHINE_TYPE_CODE = /^(?=.*\d)[A-Z0-9]{6,}$/
const MAX_MODEL_CHARS = 64

const LINUX_LAPTOP_CHASSIS = new Set([8, 9, 10, 14, 31, 32])
const LINUX_DESKTOP_CHASSIS = new Set([3, 4, 5, 6, 7, 13, 15, 16, 35, 36])
// Win32_ComputerSystem.PCSystemType: Enterprise Server, SOHO Server, Performance Server.
const WINDOWS_SERVER_PC_SYSTEM_TYPES = new Set([4, 5, 7])
const WINDOWS_MOBILE_PC_SYSTEM_TYPE = 2
// Win32_OperatingSystem.ProductType: domain controller, server.
const WINDOWS_SERVER_PRODUCT_TYPES = new Set([2, 3])

export const MAC_FALLBACK_MACHINE: HostMachine = { kind: 'desktop', model: null }
export const WINDOWS_FALLBACK_MACHINE: HostMachine = { kind: 'desktop', model: null }
const LINUX_FALLBACK_MACHINE: HostMachine = { kind: 'server', model: null }

function cleanModelName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.replace(/\s+/g, ' ').trim()
  if (!trimmed || trimmed.length > MAX_MODEL_CHARS || PLACEHOLDER_MODEL.test(trimmed)) {
    return null
  }
  return trimmed
}

function pickModelName(productName: unknown, productFamily: unknown): string | null {
  const name = cleanModelName(productName)
  const family = cleanModelName(productFamily)
  if (name && MACHINE_TYPE_CODE.test(name) && family) {
    return family
  }
  return name ?? family
}

function isVirtualMachine(...fields: unknown[]): boolean {
  return fields.some((field) => typeof field === 'string' && VIRTUAL_MACHINE.test(field))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonRecord(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** `system_profiler SPHardwareDataType -json`; `machine_name` is the marketing name on Intel and Apple silicon. */
export function parseMacHardwareProfile(stdout: string): HostMachine | null {
  const items = parseJsonRecord(stdout)?.SPHardwareDataType
  const item: unknown = Array.isArray(items) ? items[0] : undefined
  if (!isRecord(item)) {
    return null
  }
  const model = cleanModelName(item.machine_name)
  const identifier = typeof item.machine_model === 'string' ? item.machine_model : ''
  const laptop = /^MacBook/i.test(model ?? identifier)
  return { kind: laptop ? 'laptop' : 'desktop', model }
}

/** JSON object of Win32_ComputerSystem PCSystemType/Model/Manufacturer/SystemFamily plus Win32_OperatingSystem ProductType. */
export function parseWindowsComputerSystem(stdout: string): HostMachine | null {
  const row = parseJsonRecord(stdout)
  if (!row) {
    return null
  }
  const pcSystemType = typeof row.PCSystemType === 'number' ? row.PCSystemType : null
  const productType = typeof row.ProductType === 'number' ? row.ProductType : null
  const virtual = isVirtualMachine(row.Manufacturer, row.Model)
  const server =
    virtual ||
    (pcSystemType !== null && WINDOWS_SERVER_PC_SYSTEM_TYPES.has(pcSystemType)) ||
    (productType !== null && WINDOWS_SERVER_PRODUCT_TYPES.has(productType))
  return {
    kind: server ? 'server' : pcSystemType === WINDOWS_MOBILE_PC_SYSTEM_TYPE ? 'laptop' : 'desktop',
    model: virtual ? null : pickModelName(row.Model, row.SystemFamily)
  }
}

export type LinuxDmiFields = {
  chassisType: string | null
  productName: string | null
  productFamily: string | null
  sysVendor: string | null
}

/** `/sys/class/dmi/id` fields; no DMI (containers, ARM boards) or a VM reads as a server. */
export function parseLinuxDmi(fields: LinuxDmiFields): HostMachine {
  if (isVirtualMachine(fields.sysVendor, fields.productName)) {
    return LINUX_FALLBACK_MACHINE
  }
  const chassis = fields.chassisType === null ? Number.NaN : Number(fields.chassisType.trim())
  const kind = LINUX_LAPTOP_CHASSIS.has(chassis)
    ? 'laptop'
    : LINUX_DESKTOP_CHASSIS.has(chassis)
      ? 'desktop'
      : 'server'
  return { kind, model: pickModelName(fields.productName, fields.productFamily) }
}
