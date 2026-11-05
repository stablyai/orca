const { existsSync } = require('node:fs')
const { join } = require('node:path')

// Only main-valued switches compile dark paths; marked main/mobile-web/orcad/template outputs cannot ship.
// Packaging and release templates also reject enabled switch environment variables.
const DARK_BUILD_SWITCHES = [
  // src/shared/layout-owner-switch.ts
  { variable: 'ORCA_LAYOUT_OWNER', off: 'window' },
  // src/shared/sidebar-inputs-switch.ts
  { variable: 'ORCA_SIDEBAR_INPUTS', off: 'window' }
]

function markerFileName(darkSwitch) {
  return `${darkSwitch.variable}_MAIN`
}

function turnedOn(env) {
  return DARK_BUILD_SWITCHES.filter((darkSwitch) => env[darkSwitch.variable] === 'main')
}

/** Every switch's define: 'main' only when asked, so other builds fold the branches away. */
function darkBuildDefines(env = process.env) {
  const on = turnedOn(env)
  return Object.fromEntries(
    DARK_BUILD_SWITCHES.map((darkSwitch) => [
      darkSwitch.variable,
      JSON.stringify(on.includes(darkSwitch) ? 'main' : darkSwitch.off)
    ])
  )
}

/** Only the switches asked for: an undeclared switch already reads as off. */
function turnedOnDarkBuildDefines(env = process.env) {
  return Object.fromEntries(
    turnedOn(env).map((darkSwitch) => [darkSwitch.variable, JSON.stringify('main')])
  )
}

function darkBuildMarkerFileNames() {
  return DARK_BUILD_SWITCHES.map(markerFileName)
}

function darkBuildMarkers(env = process.env) {
  return turnedOn(env).map((darkSwitch) => ({
    fileName: markerFileName(darkSwitch),
    text: `Built with ${darkSwitch.variable}=main, for dark testing only.\n`
  }))
}

function assertUnmarked(outputDirs, switches) {
  for (const darkSwitch of switches) {
    const marked = outputDirs.find((dir) => existsSync(join(dir, markerFileName(darkSwitch))))
    if (marked) {
      throw new Error(
        `${marked} holds an ${darkSwitch.variable}=main build; rebuild it without that variable first.`
      )
    }
  }
}

function assertNotDarkBuild(outputDirs, env = process.env) {
  const [asked] = turnedOn(env)
  if (asked) {
    throw new Error(
      `${asked.variable}=main is for dark test builds; unset it to package a release.`
    )
  }
  assertUnmarked(outputDirs, DARK_BUILD_SWITCHES)
}

/** For a build that may itself be dark: refuses only outputs marked by a switch this build has off. */
function assertNoDarkOutputOfOffSwitches(outputDirs, env = process.env) {
  const on = turnedOn(env)
  assertUnmarked(
    outputDirs,
    DARK_BUILD_SWITCHES.filter((darkSwitch) => !on.includes(darkSwitch))
  )
}

module.exports = {
  assertNoDarkOutputOfOffSwitches,
  assertNotDarkBuild,
  darkBuildDefines,
  darkBuildMarkerFileNames,
  darkBuildMarkers,
  turnedOnDarkBuildDefines
}
