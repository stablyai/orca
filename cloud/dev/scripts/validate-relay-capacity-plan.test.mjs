import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateCapacityPlan as validateCapacityPlanRaw } from './validate-relay-capacity-plan.mjs'

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
  const audience = 'https://relay.example.com/v1/admin/host-drain'
  const startup = ({ selectedImage, cap = 1_000, trust = false }) => [
    `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '${cap}'`,
    `  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '60'`,
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
    rehomeDirectorServiceAccount: directorIdentity,
    rehomeAudience: audience
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
