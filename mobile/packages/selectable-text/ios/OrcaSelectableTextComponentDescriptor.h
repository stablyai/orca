#pragma once

#include "OrcaSelectableTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using OrcaSelectableTextComponentDescriptor = ConcreteComponentDescriptor<OrcaSelectableTextShadowNode>;

void OrcaSelectableTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
