import type * as yaml from 'yaml'

export function loadYaml(): typeof yaml {
  return require('yaml')
}
