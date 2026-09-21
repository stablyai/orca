import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  RELAY_CELL_CONNECTION_DRAIN_SECONDS,
  RELAY_CELL_LOG_SAMPLE_RATE
} from './validate-relay-asia-topology-plan.mjs'
import {
  parseCapacityPlanArguments,
  validateCapacityPlan as validateCapacityPlanRaw
} from './validate-relay-capacity-plan.mjs'

const config = {
  cellId: 'staging-gce-c3',
  hardCap: 1_000,
  unobservedBound: 60
}

function replacementConfiguration(references = [
  'google_compute_instance_template.relay_gce_cell',
  'each.key'
]) {
  return {
    root_module: {
      resources: [{
        address: 'google_compute_instance_group_manager.relay_gce_cell',
        expressions: {
          version: [{
            instance_template: { references },
            name: { constant_value: 'primary' }
          }]
        }
      }]
    }
  }
}

function validateCapacityPlan(plan, planConfig) {
  const replacement = plan.resource_changes.some(({ change }) =>
    JSON.stringify(change?.actions) === JSON.stringify(['create', 'delete']))
  return validateCapacityPlanRaw(
    replacement && !plan.configuration
      ? { ...plan, configuration: replacementConfiguration() }
      : plan,
    planConfig
  )
}

test('accepts only the exact canary template replacement and MIG update', () => {
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'a'.repeat(64)}`
  const startupScript = (cap, bound, selectedImage, extra = '') =>
    [
      `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '${cap}'`,
      `  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '${bound}'`,
      `printf 'ORCA_RELAY_IMAGE_DIGEST=%s\\n' '${selectedImage.split('@')[1]}'`,
      `docker pull '${selectedImage}'`,
      extra,
      'docker run --detach \\',
      '  --name cloud-sql-proxy \\',
      `  'us-docker.pkg.dev/project/proxy@sha256:${'c'.repeat(64)}'`,
      'docker run --detach \\',
      '  --name orca-relay \\',
      `  '${selectedImage}'`
    ].join('\n')
  const script = startupScript(1_000, 60, image)
  const template = {
    address: 'google_compute_instance_template.relay_gce_cell["staging-gce-c3"]',
    change: {
      actions: ['create', 'delete'],
      before: {
        metadata_startup_script: startupScript(
          600,
          60,
          `us-docker.pkg.dev/project/relay/image@sha256:${'b'.repeat(64)}`
        )
      },
      after: { metadata_startup_script: script, self_link: null },
      after_unknown: { self_link: true }
    }
  }
  const manager = {
    address: 'google_compute_instance_group_manager.relay_gce_cell["staging-gce-c3"]',
    change: {
      actions: ['update'],
      before: { target_size: 1, version: [{ instance_template: 'old' }] },
      after: { target_size: 1, version: [{ instance_template: null }] },
      after_unknown: { version: [{ instance_template: true }] }
    }
  }
  const cellConfig = { ...config, mode: 'cell', image }
  assert.deepEqual(validateCapacityPlan({ resource_changes: [] }, cellConfig), {
    mode: 'cell',
    changes: 0
  })
  assert.deepEqual(validateCapacityPlan({ resource_changes: [template, manager] }, cellConfig), {
    mode: 'cell',
    changes: 2
  })
  const wrongTemplateManager = structuredClone(manager)
  wrongTemplateManager.change.after.version[0].instance_template =
    'projects/project/global/instanceTemplates/unreviewed'
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, wrongTemplateManager] },
      cellConfig
    ),
    /does not bind the MIG/
  )
  assert.throws(
    () => validateCapacityPlanRaw(
      {
        resource_changes: [template, manager],
        configuration: replacementConfiguration([
          'google_compute_instance_template.relay_gce_cell',
          'var.unreviewed_key'
        ])
      },
      cellConfig
    ),
    /reviewed template dependency/
  )
  assert.throws(
    () => validateCapacityPlanRaw(
      { resource_changes: [template, manager] },
      cellConfig
    ),
    /reviewed template dependency/
  )
  const capacityServiceAccount =
    'orca-cloud-staging-gha-cap@onorca-cloud-staging.iam.gserviceaccount.com'
  const bootstrapTemplate = structuredClone(template)
  const bootstrapManager = structuredClone(manager)
  bootstrapTemplate.change.after.metadata_startup_script = [
    `  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' '${capacityServiceAccount}'`,
    script
  ].join('\n')
  const bootstrapConfig = {
    ...cellConfig,
    mode: 'bootstrap-cell',
    capacityServiceAccount
  }
  const plannedValues = (startupScript) => ({
    root_module: {
      resources: [
        {
          address: bootstrapTemplate.address,
          values: {
            metadata_startup_script: startupScript,
            self_link: 'projects/project/global/instanceTemplates/c26-reviewed'
          }
        },
        {
          address: bootstrapManager.address,
          values: {
            version: [{
              instance_template:
                'https://www.googleapis.com/compute/v1/projects/project/global/instanceTemplates/c26-reviewed'
            }]
          }
        }
      ]
    }
  })
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [bootstrapTemplate, bootstrapManager] },
      bootstrapConfig
    ),
    { mode: 'bootstrap-cell', changes: 2 }
  )
  const managerOnly = structuredClone(bootstrapManager)
  assert.deepEqual(
    validateCapacityPlan(
      {
        resource_changes: [managerOnly],
        planned_values: plannedValues(
          bootstrapTemplate.change.after.metadata_startup_script
        )
      },
      bootstrapConfig
    ),
    { mode: 'bootstrap-cell', changes: 1 }
  )
  const decoyPlannedValues = plannedValues(
    bootstrapTemplate.change.after.metadata_startup_script.replaceAll(
      image,
      `us-docker.pkg.dev/project/relay/image@sha256:${'b'.repeat(64)}`
    ) + `\n# decoy '${image}'`
  )
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [managerOnly], planned_values: decoyPlannedValues },
      bootstrapConfig
    ),
    /reviewed image and capacity/
  )
  const obsoleteTemplate = structuredClone(bootstrapTemplate)
  obsoleteTemplate.deposed = 'retired-template'
  obsoleteTemplate.change.actions = ['delete']
  obsoleteTemplate.change.after = null
  assert.deepEqual(
    validateCapacityPlan(
      {
        resource_changes: [managerOnly, obsoleteTemplate],
        planned_values: plannedValues(
          bootstrapTemplate.change.after.metadata_startup_script
        )
      },
      bootstrapConfig
    ),
    { mode: 'bootstrap-cell', changes: 2 }
  )
  assert.deepEqual(
    validateCapacityPlan(
      {
        resource_changes: [obsoleteTemplate],
        planned_values: plannedValues(
          bootstrapTemplate.change.after.metadata_startup_script
        )
      },
      bootstrapConfig
    ),
    { mode: 'bootstrap-cell', changes: 1 }
  )
  const wrongManagerReference = plannedValues(
    bootstrapTemplate.change.after.metadata_startup_script
  )
  wrongManagerReference.root_module.resources[1].values.version[0].instance_template =
    'projects/project/global/instanceTemplates/not-reviewed'
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [managerOnly], planned_values: wrongManagerReference },
      bootstrapConfig
    ),
    /does not bind the MIG/
  )
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [managerOnly] },
      bootstrapConfig
    ),
    /no exact planned C26 state/
  )
  const restartedBootstrapManager = structuredClone(bootstrapManager)
  restartedBootstrapManager.change.before.update_policy = [{ minimal_action: 'RESTART' }]
  restartedBootstrapManager.change.after.update_policy = [{ minimal_action: 'REPLACE' }]
  restartedBootstrapManager.change.before.version[0].name =
    '0/2026-08-10 23:30:14.196895+00:00'
  restartedBootstrapManager.change.after.version[0].name = 'primary'
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [bootstrapTemplate, restartedBootstrapManager] },
      bootstrapConfig
    ),
    { mode: 'bootstrap-cell', changes: 2 }
  )
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [template, restartedBootstrapManager] },
        cellConfig
      ),
    /outside the reviewed capacity fields/
  )
  const unrecognizedRestartManager = structuredClone(restartedBootstrapManager)
  unrecognizedRestartManager.change.before.version[0].name = 'operator-version'
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [bootstrapTemplate, unrecognizedRestartManager] },
        bootstrapConfig
      ),
    /outside the reviewed capacity fields/
  )
  const unrecognizedRestartPolicy = structuredClone(restartedBootstrapManager)
  unrecognizedRestartPolicy.change.before.update_policy[0].minimal_action = 'REFRESH'
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [bootstrapTemplate, unrecognizedRestartPolicy] },
        bootstrapConfig
      ),
    /outside the reviewed capacity fields/
  )
  const unrecognizedPrimaryVersion = structuredClone(restartedBootstrapManager)
  unrecognizedPrimaryVersion.change.after.version[0].name = 'other'
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [bootstrapTemplate, unrecognizedPrimaryVersion] },
        bootstrapConfig
      ),
    /outside the reviewed capacity fields/
  )
  const unrecognizedRestoredPolicy = structuredClone(restartedBootstrapManager)
  unrecognizedRestoredPolicy.change.after.update_policy[0].minimal_action = 'REFRESH'
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [bootstrapTemplate, unrecognizedRestoredPolicy] },
        bootstrapConfig
      ),
    /outside the reviewed capacity fields/
  )
  const missingRestartPolicy = structuredClone(restartedBootstrapManager)
  delete missingRestartPolicy.change.before.update_policy
  delete missingRestartPolicy.change.after.update_policy
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [bootstrapTemplate, missingRestartPolicy] },
        bootstrapConfig
      ),
    /outside the reviewed capacity fields/
  )
  const missingRestartVersion = structuredClone(restartedBootstrapManager)
  missingRestartVersion.change.before.version[0].name = 'primary'
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [bootstrapTemplate, missingRestartVersion] },
        bootstrapConfig
      ),
    /outside the reviewed capacity fields/
  )
  const duplicateHardCapTemplate = structuredClone(template)
  duplicateHardCapTemplate.change.after.metadata_startup_script = [
    script,
    `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '600'`
  ].join('\n')
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [duplicateHardCapTemplate, structuredClone(manager)] },
        cellConfig
      ),
    /reviewed image and capacity/
  )
  const duplicateIdentityTemplate = structuredClone(bootstrapTemplate)
  duplicateIdentityTemplate.change.after.metadata_startup_script = [
    duplicateIdentityTemplate.change.after.metadata_startup_script,
    `  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' 'other-capacity@onorca-cloud-staging.iam.gserviceaccount.com'`
  ].join('\n')
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [duplicateIdentityTemplate, structuredClone(bootstrapManager)] },
        bootstrapConfig
      ),
    /reviewed image and capacity/
  )
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [bootstrapTemplate, bootstrapManager] },
        { ...bootstrapConfig, capacityServiceAccount: 'invalid' }
      ),
    /invalid service account/
  )
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [bootstrapTemplate, bootstrapManager] },
        cellConfig
      ),
    /reviewed image and capacity/
  )
  manager.change.after.target_size = 0
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [template, manager] }, cellConfig),
    /outside the reviewed capacity fields/
  )
  manager.change.after.target_size = 1
  template.change.after.metadata_startup_script = startupScript(1_000, 60, image, 'curl bad')
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [template, manager] }, cellConfig),
    /reviewed image and capacity/
  )
  template.change.after.metadata_startup_script = startupScript(
    1_000,
    60,
    image,
    'curl bad # ORCA_RELAY_CELL_CONNECTION_HARD_CAP='
  )
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [template, manager] }, cellConfig),
    /reviewed image and capacity/
  )
  template.change.after.metadata_startup_script = script
  template.change.after_unknown = {
    id: true,
    self_link: true,
    disk: [{ architecture: true }]
  }
  manager.change.after_unknown = {
    fingerprint: true,
    version: [{ instance_template: true }]
  }
  assert.deepEqual(validateCapacityPlan({ resource_changes: [template, manager] }, cellConfig), {
    mode: 'cell',
    changes: 2
  })
  template.change.before.description = ''
  template.change.after.description = null
  template.change.before.disk = [{
    architecture: '',
    source_image: 'projects/cos-cloud/global/images/cos-stable-1'
  }]
  template.change.after.disk = [{
    source_image: 'https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-1'
  }]
  template.change.after_unknown.disk = [{ architecture: true }]
  assert.deepEqual(validateCapacityPlan({ resource_changes: [template, manager] }, cellConfig), {
    mode: 'cell',
    changes: 2
  })
  template.change.after.disk[0].source_image =
    'https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/different'
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [template, manager] }, cellConfig),
    /outside the reviewed capacity fields/
  )
  template.change.after.disk[0].source_image =
    'https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-1'
  manager.change.after_unknown = { target_size: true }
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [template, manager] }, cellConfig),
    /outside the reviewed capacity fields/
  )
})

test('same-cap mode preserves 1000/60 while adding only the reviewed trust config', () => {
  const rollbackImage = `us-docker.pkg.dev/project/relay/image@sha256:${'d'.repeat(64)}`
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'e'.repeat(64)}`
  const directorIdentity = 'relay-director@project.iam.gserviceaccount.com'
  const capacityIdentity = 'orca-cloud-gha-cap@project.iam.gserviceaccount.com'
  const audience = 'https://relay.example.com/v1/admin/host-drain'
  const startup = ({ selectedImage, cap = 1_000, trust = false, capacity = capacityIdentity }) => [
    `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '${cap}'`,
    `  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '60'`,
    ...(capacity === null
      ? []
      : [`  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' '${capacity}'`]),
    ...(trust ? [
      `  printf 'ORCA_RELAY_REHOME_DIRECTOR_SERVICE_ACCOUNT=%s\\n' '${directorIdentity}'`,
      `  printf 'ORCA_RELAY_REHOME_AUDIENCE=%s\\n' '${audience}'`
    ] : []),
    `printf 'ORCA_RELAY_IMAGE_DIGEST=%s\\n' '${selectedImage.split('@')[1]}'`,
    `docker pull '${selectedImage}'`,
    'docker run --detach \\',
    '  --name orca-relay \\',
    `  '${selectedImage}'`
  ].join('\n')
  const template = {
    address: 'google_compute_instance_template.relay_gce_cell["staging-gce-c3"]',
    change: {
      actions: ['create', 'delete'],
      before: { metadata_startup_script: startup({ selectedImage: rollbackImage }) },
      after: {
        metadata_startup_script: startup({ selectedImage: image, trust: true }),
        self_link: null
      },
      after_unknown: { self_link: true }
    }
  }
  const manager = {
    address: 'google_compute_instance_group_manager.relay_gce_cell["staging-gce-c3"]',
    change: {
      actions: ['update'],
      before: { target_size: 1, version: [{ instance_template: 'old' }] },
      after: { target_size: 1, version: [{ instance_template: null }] },
      after_unknown: { version: [{ instance_template: true }] }
    }
  }
  const sameCapConfig = {
    ...config,
    mode: 'same-cap-cell',
    image,
    rollbackImage,
    capacityServiceAccount: capacityIdentity,
    rehomeDirectorServiceAccount: directorIdentity,
    rehomeAudience: audience,
    regionalRehomeProtocol: '1'
  }
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [template, manager] }, sameCapConfig),
    { mode: 'same-cap-cell', changes: 2 }
  )
  // A pre-template-apply rollback resume validates drift for the image the
  // cell already serves: the template leaves and re-enters the rollback image.
  const resumeTemplate = structuredClone(template)
  resumeTemplate.change.after.metadata_startup_script = startup({
    selectedImage: rollbackImage,
    trust: true
  })
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [resumeTemplate, manager] },
      { ...sameCapConfig, image: rollbackImage }
    ),
    { mode: 'same-cap-cell', changes: 2 }
  )
  const asiaTemplate = structuredClone(template)
  const asiaManager = structuredClone(manager)
  asiaTemplate.address =
    'google_compute_instance_template.relay_gce_cell["production-gce-c28"]'
  asiaManager.address =
    'google_compute_instance_group_manager.relay_gce_cell["production-gce-c28"]'
  asiaTemplate.change.before.metadata_startup_script = startup({
    selectedImage: rollbackImage,
    cap: 3_000
  })
  asiaTemplate.change.after.metadata_startup_script = startup({
    selectedImage: image,
    cap: 3_000,
    trust: true
  })
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [asiaTemplate, asiaManager] },
      { ...sameCapConfig, cellId: 'production-gce-c28', hardCap: 3_000 }
    ),
    { mode: 'same-cap-cell', changes: 2 }
  )
  const changedCap = structuredClone(template)
  changedCap.change.before.metadata_startup_script = startup({
    selectedImage: rollbackImage,
    cap: 600
  })
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [changedCap, manager] }, sameCapConfig),
    /reviewed image and capacity/
  )
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager] },
      { ...sameCapConfig, rollbackImage: image }
    ),
    /reviewed image and capacity/
  )
  const wrongTrust = structuredClone(template)
  wrongTrust.change.after.metadata_startup_script = startup({
    selectedImage: image,
    trust: true
  }).replace(directorIdentity, 'other-director@project.iam.gserviceaccount.com')
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [wrongTrust, manager] }, sameCapConfig),
    /reviewed image and capacity/
  )

  const imageOnly = structuredClone(template)
  imageOnly.change.after.metadata_startup_script = startup({ selectedImage: image })
  const imageOnlyConfig = {
    ...config,
    mode: 'same-cap-image',
    image,
    rollbackImage
  }
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [imageOnly, manager] }, imageOnlyConfig),
    { mode: 'same-cap-image', changes: 2, changeKind: 'replacement' }
  )
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [imageOnly, manager] },
      { ...imageOnlyConfig, rollbackImage: image }
    ),
    /reviewed image and capacity/
  )
  const changedTrust = structuredClone(imageOnly)
  changedTrust.change.after.metadata_startup_script +=
    `\n  printf 'ORCA_RELAY_REHOME_AUDIENCE=%s\\n' '${audience}'`
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [changedTrust, manager] }, imageOnlyConfig),
    /reviewed image and capacity/
  )
  const plannedValues = {
    root_module: {
      resources: [
        {
          address: imageOnly.address,
          values: {
            metadata_startup_script: imageOnly.change.after.metadata_startup_script,
            self_link: 'projects/project/global/instanceTemplates/target'
          }
        },
        {
          address: manager.address,
          values: {
            version: [{ instance_template: 'projects/project/global/instanceTemplates/target' }]
          }
        }
      ]
    }
  }
  const obsoleteTemplate = structuredClone(imageOnly)
  obsoleteTemplate.deposed = 'obsolete'
  obsoleteTemplate.change.actions = ['delete']
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [obsoleteTemplate], planned_values: plannedValues },
      imageOnlyConfig
    ),
    { mode: 'same-cap-image', changes: 1, changeKind: 'obsolete-template-delete' }
  )
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [imageOnly, manager, obsoleteTemplate] },
      imageOnlyConfig
    ),
    { mode: 'same-cap-image', changes: 3, changeKind: 'replacement-with-obsolete-template' }
  )
  const anotherObsoleteTemplate = {
    ...structuredClone(obsoleteTemplate),
    deposed: 'another-obsolete'
  }
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [imageOnly, manager, obsoleteTemplate, anotherObsoleteTemplate] },
      imageOnlyConfig
    ),
    { mode: 'same-cap-image', changes: 4, changeKind: 'replacement-with-obsolete-template' }
  )
  assert.deepEqual(
    validateCapacityPlan(
      {
        resource_changes: [obsoleteTemplate, anotherObsoleteTemplate],
        planned_values: plannedValues
      },
      imageOnlyConfig
    ),
    { mode: 'same-cap-image', changes: 2, changeKind: 'obsolete-template-delete' }
  )
  assert.deepEqual(
    validateCapacityPlan(
      {
        resource_changes: [manager, obsoleteTemplate, anotherObsoleteTemplate],
        planned_values: plannedValues
      },
      imageOnlyConfig
    ),
    { mode: 'same-cap-image', changes: 3, changeKind: 'manager-convergence' }
  )
  const invalidObsoleteTemplate = structuredClone(anotherObsoleteTemplate)
  invalidObsoleteTemplate.change.actions = ['update']
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [imageOnly, manager, obsoleteTemplate, invalidObsoleteTemplate] },
      imageOnlyConfig
    ),
    /change only the exact instance template and MIG/
  )
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [manager], planned_values: plannedValues },
      imageOnlyConfig
    ),
    { mode: 'same-cap-image', changes: 1, changeKind: 'manager-convergence' }
  )
})

test('protocol-0 same-cap cells roll without rehome trust lines', () => {
  const rollbackImage = `us-docker.pkg.dev/project/relay/image@sha256:${'d'.repeat(64)}`
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'e'.repeat(64)}`
  const directorIdentity = 'relay-director@project.iam.gserviceaccount.com'
  const capacityIdentity = 'orca-cloud-gha-cap@project.iam.gserviceaccount.com'
  const audience = 'https://relay.example.com/v1/admin/host-drain'
  const startup = ({ selectedImage, trust = false }) => [
    `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '3000'`,
    `  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '60'`,
    `  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' '${capacityIdentity}'`,
    `  printf 'ORCA_RELAY_CELL_REGION=%s\\n' 'asia-east2'`,
    ...(trust ? [
      `  printf 'ORCA_RELAY_REHOME_DIRECTOR_SERVICE_ACCOUNT=%s\\n' '${directorIdentity}'`,
      `  printf 'ORCA_RELAY_REHOME_AUDIENCE=%s\\n' '${audience}'`
    ] : []),
    `printf 'ORCA_RELAY_IMAGE_DIGEST=%s\\n' '${selectedImage.split('@')[1]}'`,
    `docker pull '${selectedImage}'`,
    'docker run --detach \\',
    '  --name orca-relay \\',
    `  '${selectedImage}'`
  ].join('\n')
  const template = {
    address: 'google_compute_instance_template.relay_gce_cell["production-gce-c27"]',
    change: {
      actions: ['create', 'delete'],
      before: { metadata_startup_script: startup({ selectedImage: rollbackImage }) },
      after: { metadata_startup_script: startup({ selectedImage: image }), self_link: null },
      after_unknown: { self_link: true }
    }
  }
  const manager = {
    address: 'google_compute_instance_group_manager.relay_gce_cell["production-gce-c27"]',
    change: {
      actions: ['update'],
      before: { target_size: 1, version: [{ instance_template: 'old' }] },
      after: { target_size: 1, version: [{ instance_template: null }] },
      after_unknown: { version: [{ instance_template: true }] }
    }
  }
  const asiaConfig = {
    cellId: 'production-gce-c27',
    hardCap: 3_000,
    unobservedBound: 60,
    mode: 'same-cap-cell',
    image,
    rollbackImage,
    capacityServiceAccount: capacityIdentity,
    rehomeDirectorServiceAccount: directorIdentity,
    rehomeAudience: audience,
    regionalRehomeProtocol: '0'
  }
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [template, manager] }, asiaConfig),
    { mode: 'same-cap-cell', changes: 2 }
  )
  const gainsTrust = structuredClone(template)
  gainsTrust.change.after.metadata_startup_script = startup({
    selectedImage: image,
    trust: true
  })
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [gainsTrust, manager] }, asiaConfig),
    /reviewed image and capacity/
  )
  // Under protocol 1 that same script is the reviewed roll: trust is added, not drift.
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [gainsTrust, manager] },
      { ...asiaConfig, regionalRehomeProtocol: '1' }
    ),
    { mode: 'same-cap-cell', changes: 2 }
  )
  // A protocol-1 cell whose script has no rehome lines is the pre-existing failure, unchanged.
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager] },
      { ...asiaConfig, regionalRehomeProtocol: '1' }
    ),
    /reviewed image and capacity/
  )
  for (const protocol of [undefined, '', '2', 'yes']) {
    assert.throws(
      () => validateCapacityPlan(
        { resource_changes: [template, manager] },
        { ...asiaConfig, regionalRehomeProtocol: protocol }
      ),
      /invalid regional rehome protocol/
    )
  }
})

test('a same-cap roll may gain the pinned capacity identity but never move it', () => {
  const rollbackImage = `us-docker.pkg.dev/project/relay/image@sha256:${'d'.repeat(64)}`
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'e'.repeat(64)}`
  const directorIdentity = 'relay-director@project.iam.gserviceaccount.com'
  const capacityIdentity = 'orca-cloud-gha-cap@project.iam.gserviceaccount.com'
  const audience = 'https://relay.example.com/v1/admin/host-drain'
  const startup = ({ selectedImage, capacity }) => [
    `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '600'`,
    `  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '60'`,
    ...(capacity === null
      ? []
      : [`  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' '${capacity}'`]),
    `printf 'ORCA_RELAY_IMAGE_DIGEST=%s\\n' '${selectedImage.split('@')[1]}'`,
    `docker pull '${selectedImage}'`,
    'docker run --detach \\',
    '  --name orca-relay \\',
    `  '${selectedImage}'`
  ].join('\n')
  const plan = (beforeCapacity, afterCapacity) => ({
    resource_changes: [
      {
        address: 'google_compute_instance_template.relay_gce_cell["production-gce-c17"]',
        change: {
          actions: ['create', 'delete'],
          before: {
            metadata_startup_script: startup({
              selectedImage: rollbackImage,
              capacity: beforeCapacity
            })
          },
          after: {
            metadata_startup_script: startup({ selectedImage: image, capacity: afterCapacity }),
            self_link: null
          },
          after_unknown: { self_link: true }
        }
      },
      {
        address: 'google_compute_instance_group_manager.relay_gce_cell["production-gce-c17"]',
        change: {
          actions: ['update'],
          before: { target_size: 1, version: [{ instance_template: 'old' }] },
          after: { target_size: 1, version: [{ instance_template: null }] },
          after_unknown: { version: [{ instance_template: true }] }
        }
      }
    ]
  })
  const config = {
    cellId: 'production-gce-c17',
    hardCap: 600,
    unobservedBound: 60,
    mode: 'same-cap-cell',
    image,
    rollbackImage,
    capacityServiceAccount: capacityIdentity,
    rehomeDirectorServiceAccount: directorIdentity,
    rehomeAudience: audience,
    regionalRehomeProtocol: '0'
  }
  // A template old enough to predate the line gains it, which is the only move allowed.
  assert.deepEqual(
    validateCapacityPlan(plan(null, capacityIdentity), config),
    { mode: 'same-cap-cell', changes: 2 }
  )
  assert.deepEqual(
    validateCapacityPlan(plan(capacityIdentity, capacityIdentity), config),
    { mode: 'same-cap-cell', changes: 2 }
  )
  for (const [before, after] of [
    [capacityIdentity, null],
    [null, null],
    [capacityIdentity, 'orca-cloud-gha-other@project.iam.gserviceaccount.com'],
    [null, 'orca-cloud-gha-other@project.iam.gserviceaccount.com']
  ]) {
    assert.throws(
      () => validateCapacityPlan(plan(before, after), config),
      /reviewed image and capacity/,
      `${before} -> ${after}`
    )
  }
  // Without the pin there is nothing reviewing the line the comparison now ignores.
  assert.throws(
    () => validateCapacityPlan(plan(null, capacityIdentity), {
      ...config,
      capacityServiceAccount: undefined
    }),
    /invalid service account/
  )
  assert.throws(
    () => validateCapacityPlan(plan(null, capacityIdentity), {
      ...config,
      capacityServiceAccount: 'not-an-email'
    }),
    /invalid service account/
  )
})

test('the capacity identity argument is required by same-cap-cell mode', () => {
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'e'.repeat(64)}`
  const rollbackImage = `us-docker.pkg.dev/project/relay/image@sha256:${'d'.repeat(64)}`
  const base = [
    '--mode', 'same-cap-cell',
    '--cell-id', 'production-gce-c17',
    '--hard-cap', '600',
    '--unobserved-bound', '60',
    '--image', image,
    '--rollback-image', rollbackImage,
    '--rehome-director-service-account', 'relay-director@project.iam.gserviceaccount.com',
    '--rehome-audience', 'https://relay.onorca.dev/v1/admin/host-drain',
    '--regional-rehome-protocol', '0'
  ]
  assert.throws(() => parseCapacityPlanArguments(base), /missing --capacity-service-account/)
  assert.throws(
    () => parseCapacityPlanArguments([...base, '--capacity-service-account', 'nope']),
    /--capacity-service-account is invalid/
  )
  assert.equal(
    parseCapacityPlanArguments([
      ...base,
      '--capacity-service-account',
      'orca-cloud-gha-cap@project.iam.gserviceaccount.com'
    ]).capacityServiceAccount,
    'orca-cloud-gha-cap@project.iam.gserviceaccount.com'
  )
})

test('the rehome protocol argument is required by same-cap-cell mode alone', () => {
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'e'.repeat(64)}`
  const rollbackImage = `us-docker.pkg.dev/project/relay/image@sha256:${'d'.repeat(64)}`
  const sameCapArguments = (...extra) => [
    '--mode', 'same-cap-cell',
    '--cell-id', 'production-gce-c27',
    '--hard-cap', '3000',
    '--unobserved-bound', '60',
    '--image', image,
    '--rollback-image', rollbackImage,
    '--capacity-service-account', 'orca-cloud-gha-cap@project.iam.gserviceaccount.com',
    '--rehome-director-service-account', 'relay-director@project.iam.gserviceaccount.com',
    '--rehome-audience', 'https://relay.onorca.dev/v1/admin/host-drain',
    ...extra
  ]
  assert.equal(
    parseCapacityPlanArguments(sameCapArguments('--regional-rehome-protocol', '0'))
      .regionalRehomeProtocol,
    '0'
  )
  assert.equal(
    parseCapacityPlanArguments(sameCapArguments('--regional-rehome-protocol', '3')).regionalRehomeProtocol,
    '3'
  )
  assert.throws(
    () => parseCapacityPlanArguments(sameCapArguments()),
    /requires rollback image and rehome trust config/
  )
  for (const protocol of ['', '2', 'true']) {
    assert.throws(
      () => parseCapacityPlanArguments(sameCapArguments('--regional-rehome-protocol', protocol)),
      /requires rollback image and rehome trust config/
    )
  }
  assert.throws(
    () => parseCapacityPlanArguments([
      '--mode', 'bootstrap-cell',
      '--cell-id', 'staging-gce-c3',
      '--hard-cap', '1000',
      '--unobserved-bound', '60',
      '--image', image,
      '--capacity-service-account', 'orca-cap@onorca-cloud.iam.gserviceaccount.com',
      '--regional-rehome-protocol', '0'
    ]),
    /applies only to same-cap-cell validation/
  )
})

test('the reviewed database pool is pinned for the cells that emit one', () => {
  const rollbackImage = `us-docker.pkg.dev/project/relay/image@sha256:${'d'.repeat(64)}`
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'e'.repeat(64)}`
  const directorIdentity = 'relay-director@project.iam.gserviceaccount.com'
  const capacityIdentity = 'orca-cloud-gha-cap@project.iam.gserviceaccount.com'
  const audience = 'https://relay.example.com/v1/admin/host-drain'
  const startup = ({ selectedImage, pool }) => [
    `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '3000'`,
    `  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '60'`,
    `  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' '${capacityIdentity}'`,
    ...(pool === undefined
      ? []
      : [`  printf 'ORCA_RELAY_DATABASE_POOL_MAX=%s\\n' '${pool}'`]),
    `  printf 'ORCA_RELAY_REHOME_DIRECTOR_SERVICE_ACCOUNT=%s\\n' '${directorIdentity}'`,
    `  printf 'ORCA_RELAY_REHOME_AUDIENCE=%s\\n' '${audience}'`,
    `printf 'ORCA_RELAY_IMAGE_DIGEST=%s\\n' '${selectedImage.split('@')[1]}'`,
    `docker pull '${selectedImage}'`,
    'docker run --detach \\',
    '  --name orca-relay \\',
    `  '${selectedImage}'`
  ].join('\n')
  const rollPlan = (before, after) => ({
    resource_changes: [
      {
        address: 'google_compute_instance_template.relay_gce_cell["production-gce-c27"]',
        change: {
          actions: ['create', 'delete'],
          before: {
            metadata_startup_script: startup({ selectedImage: rollbackImage, pool: before })
          },
          after: {
            metadata_startup_script: startup({ selectedImage: image, pool: after }),
            self_link: null
          },
          after_unknown: { self_link: true }
        }
      },
      {
        address: 'google_compute_instance_group_manager.relay_gce_cell["production-gce-c27"]',
        change: {
          actions: ['update'],
          before: { target_size: 1, version: [{ instance_template: 'old' }] },
          after: { target_size: 1, version: [{ instance_template: null }] },
          after_unknown: { version: [{ instance_template: true }] }
        }
      }
    ]
  })
  const asiaConfig = {
    cellId: 'production-gce-c27',
    hardCap: 3_000,
    unobservedBound: 60,
    mode: 'same-cap-cell',
    image,
    rollbackImage,
    capacityServiceAccount: capacityIdentity,
    rehomeDirectorServiceAccount: directorIdentity,
    rehomeAudience: audience,
    regionalRehomeProtocol: '1'
  }
  // The live template still says 10 while the reviewed plan says 16; only the pin bridges that.
  assert.deepEqual(
    validateCapacityPlan(rollPlan('10', '16'), { ...asiaConfig, databasePoolMax: '16' }),
    { mode: 'same-cap-cell', changes: 2 }
  )
  assert.throws(
    () => validateCapacityPlan(rollPlan('10', '16'), asiaConfig),
    /reviewed image and capacity/
  )
  assert.throws(
    () => validateCapacityPlan(rollPlan('10', '12'), { ...asiaConfig, databasePoolMax: '16' }),
    /reviewed image and capacity/
  )
  // A cell on the root pool default emits no line at all, and gaining one is real drift.
  assert.deepEqual(
    validateCapacityPlan(rollPlan(undefined, undefined), asiaConfig),
    { mode: 'same-cap-cell', changes: 2 }
  )
  assert.throws(
    () => validateCapacityPlan(rollPlan(undefined, '16'), asiaConfig),
    /reviewed image and capacity/
  )
  // A line already on the live template is still unreviewed without the pin, even standing still.
  assert.throws(
    () => validateCapacityPlan(rollPlan('16', '16'), asiaConfig),
    /reviewed image and capacity/
  )
  // A pin must also fail closed when the plan drops the line it names.
  assert.throws(
    () => validateCapacityPlan(rollPlan('16', undefined), { ...asiaConfig, databasePoolMax: '16' }),
    /reviewed image and capacity/
  )
  for (const pool of ['', '0', '101', 'ten']) {
    assert.throws(
      () => validateCapacityPlan(rollPlan('10', '16'), { ...asiaConfig, databasePoolMax: pool }),
      /invalid database pool max/
    )
  }
})

test('the database pool argument is accepted by same-cap-cell mode alone', () => {
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'e'.repeat(64)}`
  const rollbackImage = `us-docker.pkg.dev/project/relay/image@sha256:${'d'.repeat(64)}`
  const sameCapArguments = (...extra) => [
    '--mode', 'same-cap-cell',
    '--cell-id', 'production-gce-c27',
    '--hard-cap', '3000',
    '--unobserved-bound', '60',
    '--image', image,
    '--rollback-image', rollbackImage,
    '--capacity-service-account', 'orca-cloud-gha-cap@project.iam.gserviceaccount.com',
    '--rehome-director-service-account', 'relay-director@project.iam.gserviceaccount.com',
    '--rehome-audience', 'https://relay.onorca.dev/v1/admin/host-drain',
    '--regional-rehome-protocol', '1',
    ...extra
  ]
  assert.equal(
    parseCapacityPlanArguments(sameCapArguments('--database-pool-max', '16')).databasePoolMax,
    '16'
  )
  assert.equal(parseCapacityPlanArguments(sameCapArguments()).databasePoolMax, undefined)
  assert.throws(
    () => parseCapacityPlanArguments([
      '--mode', 'bootstrap-cell',
      '--cell-id', 'staging-gce-c3',
      '--hard-cap', '1000',
      '--unobserved-bound', '60',
      '--image', image,
      '--capacity-service-account', 'orca-cap@onorca-cloud.iam.gserviceaccount.com',
      '--database-pool-max', '16'
    ]),
    /applies only to same-cap-cell validation/
  )
})

test('a same-cap roll may carry only this cell backend drain and request logging', () => {
  const rollbackImage = `us-docker.pkg.dev/project/relay/image@sha256:${'d'.repeat(64)}`
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'e'.repeat(64)}`
  const capacityIdentity = 'orca-cloud-gha-cap@project.iam.gserviceaccount.com'
  const startup = (selectedImage) => [
    "  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '1000'",
    "  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '60'",
    `  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' '${capacityIdentity}'`,
    `printf 'ORCA_RELAY_IMAGE_DIGEST=%s\\n' '${selectedImage.split('@')[1]}'`,
    `docker pull '${selectedImage}'`,
    'docker run --detach \\',
    '  --name orca-relay \\',
    `  '${selectedImage}'`
  ].join('\n')
  const template = {
    address: 'google_compute_instance_template.relay_gce_cell["staging-gce-c3"]',
    change: {
      actions: ['create', 'delete'],
      before: { metadata_startup_script: startup(rollbackImage) },
      after: { metadata_startup_script: startup(image), self_link: null },
      after_unknown: { self_link: true }
    }
  }
  const manager = {
    address: 'google_compute_instance_group_manager.relay_gce_cell["staging-gce-c3"]',
    change: {
      actions: ['update'],
      before: { target_size: 1, version: [{ instance_template: 'old' }] },
      after: { target_size: 1, version: [{ instance_template: null }] },
      after_unknown: { version: [{ instance_template: true }] }
    }
  }
  // The exact shape a live US cell's backend plans: 300 s drain and no log_config at all.
  const loggingAfter = [{
    enable: true,
    optional_fields: null,
    optional_mode: null,
    sample_rate: RELAY_CELL_LOG_SAMPLE_RATE
  }]
  const backendChange = ({ drain = true, logging = true }) => ({
    address: 'google_compute_backend_service.relay_gce_cell["staging-gce-c3"]',
    change: {
      actions: ['update'],
      before: {
        connection_draining_timeout_sec: drain ? 300 : RELAY_CELL_CONNECTION_DRAIN_SECONDS,
        log_config: logging ? [] : loggingAfter,
        timeout_sec: 86_400,
        fingerprint: 'before'
      },
      after: {
        connection_draining_timeout_sec: RELAY_CELL_CONNECTION_DRAIN_SECONDS,
        log_config: loggingAfter,
        timeout_sec: 86_400,
        fingerprint: null
      },
      after_unknown: { fingerprint: true }
    }
  })
  const backend = backendChange({})
  const drainOnly = backendChange({ logging: false })
  const loggingOnly = backendChange({ drain: false })
  const sameCapConfig = {
    ...config,
    mode: 'same-cap-cell',
    image,
    rollbackImage,
    capacityServiceAccount: capacityIdentity,
    rehomeDirectorServiceAccount: 'relay-director@project.iam.gserviceaccount.com',
    rehomeAudience: 'https://relay.onorca.dev/v1/admin/host-drain',
    regionalRehomeProtocol: '0'
  }
  const refused = /only this cell backend drain and request logging/
  // Both attributes ride along with the roll without inflating the template-and-MIG count
  // the apply's stranded branch and the resume's drift branch both read.
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [template, manager, backend] }, sameCapConfig),
    {
      mode: 'same-cap-cell',
      changes: 2,
      backendUpdate: ['connection_draining_timeout_sec', 'log_config.0']
    }
  )
  // Each is independently optional: a cell that already has one plans no change for it.
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [template, manager, drainOnly] }, sameCapConfig),
    { mode: 'same-cap-cell', changes: 2, backendUpdate: ['connection_draining_timeout_sec'] }
  )
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [template, manager, loggingOnly] }, sameCapConfig),
    { mode: 'same-cap-cell', changes: 2, backendUpdate: ['log_config.0'] }
  )
  // Once both are applied the backend is simply absent from the plan.
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [template, manager] }, sameCapConfig),
    { mode: 'same-cap-cell', changes: 2 }
  )
  // A cell whose template and MIG have converged but whose backend has not is still clean.
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [backend] }, sameCapConfig),
    {
      mode: 'same-cap-cell',
      changes: 0,
      backendUpdate: ['connection_draining_timeout_sec', 'log_config.0']
    }
  )
  assert.deepEqual(validateCapacityPlan({ resource_changes: [] }, sameCapConfig), {
    mode: 'same-cap-cell',
    changes: 0
  })
  const extraAttribute = structuredClone(backend)
  extraAttribute.change.after.timeout_sec = 3_600
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager, extraAttribute] },
      sameCapConfig
    ),
    /changes outside the reviewed capacity fields/
  )
  const otherCell = structuredClone(backend)
  otherCell.address = 'google_compute_backend_service.relay_gce_cell["production-gce-c27"]'
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [template, manager, otherCell] }, sameCapConfig),
    refused
  )
  const unreviewedDrain = structuredClone(backend)
  unreviewedDrain.change.after.connection_draining_timeout_sec =
    RELAY_CELL_CONNECTION_DRAIN_SECONDS + 1
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager, unreviewedDrain] },
      sameCapConfig
    ),
    refused
  )
  const sampledLogging = structuredClone(backend)
  sampledLogging.change.after.log_config[0].sample_rate = RELAY_CELL_LOG_SAMPLE_RATE / 2
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager, sampledLogging] },
      sameCapConfig
    ),
    refused
  )
  const disabledLogging = structuredClone(backend)
  disabledLogging.change.after.log_config[0].enable = false
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager, disabledLogging] },
      sameCapConfig
    ),
    refused
  )
  const replaced = structuredClone(backend)
  replaced.change.actions = ['create', 'delete']
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [template, manager, replaced] }, sameCapConfig),
    refused
  )
  // Only the same-cap wave targets a backend service; every other mode still refuses one.
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager, backend] },
      { ...config, mode: 'cell', image }
    ),
    /only the exact instance template and MIG/
  )
})
