#pragma once

#include "OrcaSelectableTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using OrcaSelectableTextRunComponentDescriptor = ConcreteComponentDescriptor<OrcaSelectableTextRunShadowNode>;

void OrcaSelectableTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
